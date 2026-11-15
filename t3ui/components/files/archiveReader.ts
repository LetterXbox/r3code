// Archives the file viewer opens: zip and jar, tar, gz and tgz (files/binaryPreview.worker.ts and the bounded zip reader in
// client-runtime/src/zip). Read natively from the file's bytes with the runtime's zlib, so no worker or browser is needed.
// Pure (bytes in, entries out), so it is tested without an engine. ZIP64 is not read, as in the web app's bounded reader.
import { gunzipSync, inflateRawSync } from "zlib";

export const ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
export const ARCHIVE_ENTRY_MAX_BYTES = 10 * 1024 * 1024;
export const ARCHIVE_MAX_ENTRIES = 2048;
export const ARCHIVE_MAX_RATIO = 200;

export interface ArchiveEntry {
  path: string;
  size: number;
  modified: string | null;
  directory: boolean;
}

export interface OpenArchive {
  entries: ArchiveEntry[];
  /** The bytes of one file entry (an error for a directory, a missing entry or one over 10 MB). */
  read(path: string): Uint8Array;
}

export type ArchiveFormat = "zip" | "tar" | "tgz" | "gz";

/** The format a file name says: zip and jar, tar, tar.gz and tgz, gz. */
export function archiveFormat(name: string): ArchiveFormat | null {
  if (/\.(?:zip|jar)$/i.test(name)) return "zip";
  if (/\.(?:tar\.gz|tgz)$/i.test(name)) return "tgz";
  if (/\.gz$/i.test(name)) return "gz";
  if (/\.tar$/i.test(name)) return "tar";
  return null;
}

const utf8 = new TextDecoder();

function dosDate(date: number, time: number): string | null {
  const month = ((date >> 5) & 15) - 1;
  const value = new Date(Date.UTC(1980 + (date >> 9), month, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2));
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
}

export function openZip(bytes: Uint8Array, entryLimit = ARCHIVE_MAX_ENTRIES): OpenArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new Error("This is not a readable ZIP archive.");
  let count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  let cursor = view.getUint32(end + 16, true);
  if (count === 0xffff || directorySize === 0xffffffff || cursor === 0xffffffff) throw new Error("Unsupported ZIP64 directory.");
  if (count > entryLimit) throw new Error(`This archive contains more than ${String(entryLimit).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} entries.`);
  if (cursor > end - directorySize) throw new Error("This ZIP directory is damaged.");
  const entries: ArchiveEntry[] = [];
  const located = new Map<string, { method: number; compressed: number; size: number; header: number }>();
  while (count-- > 0) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) throw new Error("This ZIP directory is damaged.");
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const time = view.getUint16(cursor + 12, true);
    const date = view.getUint16(cursor + 14, true);
    const compressed = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const header = view.getUint32(cursor + 42, true);
    if (nameLength > 1024) throw new Error("An archive path is too long to preview.");
    const raw = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    // Names are UTF-8 (flag bit 11) or the legacy code page, which reads close enough as Latin-1.
    const path = (flags & 0x800) !== 0 || !raw.some((byte) => byte > 127) ? utf8.decode(raw) : Array.from(raw, (byte) => String.fromCharCode(byte)).join("");
    const directory = path.endsWith("/");
    entries.push({ path, size, modified: dosDate(date, time), directory });
    if (!directory) located.set(path, { method, compressed, size, header });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return {
    entries,
    read(path) {
      const entry = located.get(path);
      if (!entry) throw new Error("This archive entry is unavailable.");
      if (entry.size > ARCHIVE_ENTRY_MAX_BYTES) throw new Error("Entry previews are limited to 10 MB.");
      if (entry.header + 30 > bytes.length || view.getUint32(entry.header, true) !== 0x04034b50) throw new Error("This ZIP entry is damaged.");
      const start = entry.header + 30 + view.getUint16(entry.header + 26, true) + view.getUint16(entry.header + 28, true);
      const data = bytes.subarray(start, start + entry.compressed);
      if (entry.method === 0) return data.slice();
      if (entry.method !== 8) throw new Error("This ZIP entry uses an unsupported compression method.");
      const out = inflateRawSync(data);
      if (out.length > ARCHIVE_ENTRY_MAX_BYTES) throw new Error("Entry previews are limited to 10 MB.");
      return new Uint8Array(out.buffer, out.byteOffset, out.length).slice();
    },
  };
}

function openTar(bytes: Uint8Array): OpenArchive {
  const entries: ArchiveEntry[] = [];
  const files = new Map<string, Uint8Array>();
  const text = (offset: number, length: number) => utf8.decode(bytes.subarray(offset, offset + length)).split("\0", 1)[0] ?? "";
  const number = (offset: number, length: number) => {
    const value = text(offset, length).trim();
    if (!/^[0-7]*$/.test(value)) throw new Error("This TAR uses an unsupported numeric format.");
    return Number.parseInt(value || "0", 8);
  };
  let longPath: string | null = null;
  const globalPax: Record<string, string> = {};
  let localPax: Record<string, string> = {};
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    if (bytes.subarray(offset, offset + 512).every((byte) => byte === 0)) break;
    if (entries.length >= ARCHIVE_MAX_ENTRIES) throw new Error("This archive contains more than 2,048 entries.");
    let checksum = 0;
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : bytes[offset + index]!;
    if (checksum !== number(offset + 148, 8)) throw new Error("The TAR header is damaged.");
    const type = text(offset + 156, 1);
    const metadata = type === "L" || type === "x" || type === "g";
    const attributes: Record<string, string> = metadata ? {} : { ...globalPax, ...localPax };
    const size = attributes.size ? Number(attributes.size) : number(offset + 124, 12);
    if (attributes.size && !/^\d+$/.test(attributes.size)) throw new Error("An archive entry is too large or damaged.");
    const prefix = text(offset + 257, 6) === "ustar" && text(offset + 263, 2) === "00" ? text(offset + 345, 155) : "";
    const path = attributes.path || longPath || [prefix, text(offset, 100)].filter(Boolean).join("/");
    if (!metadata) { longPath = null; localPax = {}; }
    if (path.length > 1024 || !Number.isSafeInteger(size) || size < 0 || size > ARCHIVE_MAX_BYTES || offset + 512 + size > bytes.length) throw new Error("An archive entry is too large or damaged.");
    const content = bytes.subarray(offset + 512, offset + 512 + size);
    if (type === "L") longPath = utf8.decode(content).replace(/\0[\s\S]*$/, "");
    else if (type === "x" || type === "g") {
      if (size > 65536) throw new Error("Archive metadata is too large.");
      for (let cursor = 0; cursor < content.length;) {
        const separator = content.indexOf(32, cursor);
        if (separator < cursor || separator - cursor > 10) throw new Error("The TAR metadata is damaged.");
        const lengthText = utf8.decode(content.subarray(cursor, separator));
        const length = Number(lengthText);
        const stop = cursor + length;
        if (!/^[1-9]\d*$/.test(lengthText) || !Number.isSafeInteger(length) || stop > content.length || stop <= separator + 1 || content[stop - 1] !== 10) throw new Error("The TAR metadata is damaged.");
        const record = utf8.decode(content.subarray(separator + 1, stop - 1));
        const equals = record.indexOf("=");
        if (equals < 1) throw new Error("The TAR metadata is damaged.");
        const key = record.slice(0, equals);
        const value = record.slice(equals + 1);
        if (key === "path" || key === "size" || key === "mtime") {
          if (type === "x") localPax[key] = value;
          else if (value) globalPax[key] = value;
          else delete globalPax[key];
        }
        cursor = stop;
      }
    } else if (type === "" || type === "0" || type === "5") {
      if (attributes.mtime && !/^[+-]?\d+(?:\.\d+)?$/.test(attributes.mtime)) throw new Error("The TAR metadata is damaged.");
      const date = new Date((attributes.mtime ? Number(attributes.mtime) : number(offset + 136, 12)) * 1000);
      entries.push({ path, size, directory: type === "5", modified: Number.isNaN(date.getTime()) ? null : date.toISOString() });
      if (type !== "5") files.set(path, content.slice());
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (entries.length === 0) throw new Error("This archive has no readable entries.");
  return { entries, read: (path) => readFrom(files, path) };
}

function readFrom(files: Map<string, Uint8Array>, path: string): Uint8Array {
  const bytes = files.get(path);
  if (!bytes) throw new Error("This archive entry is unavailable.");
  if (bytes.length > ARCHIVE_ENTRY_MAX_BYTES) throw new Error("Entry previews are limited to 10 MB.");
  return bytes;
}

function gunzip(bytes: Uint8Array): Uint8Array {
  const out = gunzipSync(bytes);
  if (out.length > ARCHIVE_MAX_BYTES || out.length > bytes.length * ARCHIVE_MAX_RATIO) throw new Error("The expanded archive exceeds the preview size or compression ratio limit.");
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
}

/** Opens an archive by what its bytes are (a ZIP's signature, gzip's magic), falling back on its name, as the web worker does. */
export function openArchive(name: string, bytes: Uint8Array): OpenArchive {
  if (bytes.length > ARCHIVE_MAX_BYTES) throw new Error("Preview limited to files under 50 MB.");
  const signature = bytes.length >= 4 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) : 0;
  if (/\.(?:zip|jar)$/i.test(name) || signature === 0x04034b50 || signature === 0x06054b50) return openZip(bytes);
  if (/\.(?:gz|tgz)$/i.test(name) || bytes[0] === 0x1f) {
    const expanded = gunzip(bytes);
    if (/\.(?:tar\.gz|tgz)$/i.test(name)) return openTar(expanded);
    const inner = name.replace(/\.gz$/i, "") || "contents";
    if (/\.tar$/i.test(inner)) return openTar(expanded);
    const files = new Map<string, Uint8Array>([[inner, expanded]]);
    return { entries: [{ path: inner, size: expanded.length, directory: false, modified: null }], read: (path) => readFrom(files, path) };
  }
  return openTar(bytes);
}

export interface ArchiveRow { path: string; directory: boolean; size: number; modified: string | null }

/** The rows of one folder of an archive (BinaryViewer's `children`): entries below `folder`, folded to their next path part. */
export function archiveFolderRows(entries: readonly ArchiveEntry[], folder: string): ArchiveRow[] {
  const children = new Map<string, ArchiveRow>();
  for (const item of entries) {
    if (!item.path.startsWith(folder)) continue;
    const rest = item.path.slice(folder.length).replace(/\/$/, "");
    if (!rest) continue;
    const slash = rest.indexOf("/");
    const path = slash < 0 ? item.path.replace(/\/$/, "") : `${folder}${rest.slice(0, slash)}`;
    const directory = slash >= 0 || item.directory;
    const key = `${path}${directory ? "/" : ""}`;
    const previous = children.get(key);
    if (previous) previous.size += item.size;
    else children.set(key, { path, directory, size: item.size, modified: item.modified });
  }
  return [...children.values()].sort((a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path));
}

/** The parent of an archive folder path ("a/b/" -> "a/", "a/" -> ""). */
export const archiveParentFolder = (folder: string): string => folder.replace(/(?:[^/]+)?\/$/, "");
