// A plain-TS port of the reference's Chromium Local Storage (LevelDB) reader
// (t3code/apps/desktop/src/app/chromiumLocalStorage.ts), with Effect/FileSystem replaced by an injected `LegacyFs` so
// production code reads real files (through desktop/runtime.ts) while tests hand in fixture bytes and never touch the
// home directory. Read without LevelDB's lock, so another app (or process) can keep the profile open.
//
// Scope cut from the reference: this port only needs the two localStorage keys the one-time import cares about
// (prompt stash + composer drafts; see legacyLocalStorageMerge.ts), so the "database changed while reading" retry
// detection is simplified to reading CURRENT/MANIFEST once rather than re-verifying their size after the fact — a false
// positive here just means the next launch's import (if the marker was not yet written) reads a slightly older
// snapshot, not that it reads corrupt data (a torn write is caught by the log's own CRC32C checks).

const LOG_BLOCK_SIZE = 32 * 1024;
const LOG_HEADER_SIZE = 7;
const TABLE_FOOTER_SIZE = 48;
const BLOCK_TRAILER_SIZE = 5;

export class LevelDbFormatError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "LevelDbFormatError";
  }
}

const fail = (detail: string): never => {
  throw new LevelDbFormatError(detail);
};

// ignoreBOM keeps a leading U+FEFF that is part of the stored string.
const textDecoderUtf16 = new TextDecoder("utf-16le", { ignoreBOM: true });
const textDecoderUtf8 = new TextDecoder();

/** True ISO-8859-1. WHATWG's "latin1" label is windows-1252, which remaps 0x80-0x9F. */
function decodeLatin1(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return result;
}

class Reader {
  readonly bytes: Uint8Array;
  offset: number;
  constructor(bytes: Uint8Array, offset = 0) {
    this.bytes = bytes;
    this.offset = offset;
  }
  get done() {
    return this.offset >= this.bytes.length;
  }
  byte(): number {
    if (this.offset >= this.bytes.length) fail("unexpected end of data");
    return this.bytes[this.offset++]!;
  }
  varint(): number {
    let result = 0;
    let multiplier = 1;
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = this.byte();
      result += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return result;
      multiplier *= 128;
    }
    return fail("varint too long");
  }
  take(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length) fail("length out of range");
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }
  lengthPrefixed(): Uint8Array {
    return this.take(this.varint());
  }
}

const readUint32 = (bytes: Uint8Array, offset: number) =>
  (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)) + bytes[offset + 3]! * 0x1000000;

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let crc = index;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
    table[index] = crc >>> 0;
  }
  return table;
})();

export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32C_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** The inverse of `unmaskCrc` below; exported so tests can build fixture log/manifest records without re-deriving
 * LevelDB's CRC32C masking (log_format.h `Mask`: rotate right 15, then add the mask delta). */
export const maskCrc = (unmasked: number) => {
  const rotated = ((unmasked >>> 15) | (unmasked << 17)) >>> 0;
  return (rotated + 0xa282ead8) >>> 0;
};
const unmaskCrc = (masked: number) => {
  const rotated = (masked - 0xa282ead8) >>> 0;
  return ((rotated >>> 17) | (rotated << 15)) >>> 0;
};

function decompressSnappy(input: Uint8Array): Uint8Array {
  const reader = new Reader(input);
  const output = new Uint8Array(reader.varint());
  let written = 0;
  while (!reader.done) {
    const tag = reader.byte();
    const kind = tag & 3;
    if (kind === 0) {
      let length = tag >>> 2;
      if (length >= 60) {
        const extraBytes = length - 59;
        length = 0;
        for (let index = 0; index < extraBytes; index++) length += reader.byte() * 256 ** index;
      }
      length += 1;
      if (written + length > output.length) fail("snappy literal overflows output");
      output.set(reader.take(length), written);
      written += length;
      continue;
    }
    let length: number;
    let offset: number;
    if (kind === 1) {
      length = 4 + ((tag >>> 2) & 7);
      offset = ((tag >>> 5) << 8) | reader.byte();
    } else if (kind === 2) {
      length = (tag >>> 2) + 1;
      offset = reader.byte() | (reader.byte() << 8);
    } else {
      length = (tag >>> 2) + 1;
      offset = readUint32(reader.take(4), 0);
    }
    if (offset === 0 || offset > written || written + length > output.length) fail("snappy copy out of range");
    // Copies may overlap their own output, so they go byte by byte.
    for (let index = 0; index < length; index++) {
      output[written] = output[written - offset]!;
      written++;
    }
  }
  if (written !== output.length) fail("snappy output length mismatch");
  return output;
}

/** Corruption skips the remaining block; a truncated final record ends the log, matching LevelDB recovery. */
function readLogRecords(bytes: Uint8Array): Uint8Array[] {
  const records: Uint8Array[] = [];
  let pending: Uint8Array[] | null = null;
  let offset = 0;
  while (offset + LOG_HEADER_SIZE <= bytes.length) {
    const blockRemaining = LOG_BLOCK_SIZE - (offset % LOG_BLOCK_SIZE);
    if (blockRemaining < LOG_HEADER_SIZE) {
      offset += blockRemaining;
      continue;
    }
    const length = bytes[offset + 4]! | (bytes[offset + 5]! << 8);
    const type = bytes[offset + 6]!;
    const end = offset + LOG_HEADER_SIZE + length;
    const fitsBlock = LOG_HEADER_SIZE + length <= blockRemaining;
    if (fitsBlock && end > bytes.length) break;
    const typeAndPayload = bytes.subarray(offset + 6, end);
    if (type === 0 || !fitsBlock || crc32c(typeAndPayload) !== unmaskCrc(readUint32(bytes, offset))) {
      offset += blockRemaining;
      pending = null;
      continue;
    }
    const payload = typeAndPayload.subarray(1);
    offset = end;
    if (type === 1) {
      records.push(payload);
      pending = null;
    } else if (type === 2) {
      pending = [payload];
    } else if (type === 3 && pending) {
      pending.push(payload);
    } else if (type === 4 && pending) {
      pending.push(payload);
      const total = pending.reduce((sum, part) => sum + part.length, 0);
      const record = new Uint8Array(total);
      let position = 0;
      for (const part of pending) {
        record.set(part, position);
        position += part.length;
      }
      records.push(record);
      pending = null;
    } else {
      pending = null;
    }
  }
  return records;
}

interface LiveFiles {
  readonly tables: ReadonlyArray<number>;
  readonly logNumber: number;
  readonly previousLogNumber: number;
}

function readManifest(bytes: Uint8Array): LiveFiles {
  const tables = new Set<number>();
  let logNumber = 0;
  let previousLogNumber = 0;
  // LevelDB refuses to open a MANIFEST missing any of these, and so do we.
  const required = new Set([2, 3, 4]);
  for (const record of readLogRecords(bytes)) {
    const reader = new Reader(record);
    while (!reader.done) {
      const tag = reader.varint();
      required.delete(tag);
      switch (tag) {
        case 1:
          reader.lengthPrefixed();
          break;
        case 2:
          logNumber = reader.varint();
          break;
        case 3:
        case 4:
          reader.varint();
          break;
        case 5:
          reader.varint();
          reader.lengthPrefixed();
          break;
        case 6:
          reader.varint();
          tables.delete(reader.varint());
          break;
        case 7: {
          reader.varint();
          tables.add(reader.varint());
          reader.varint();
          reader.lengthPrefixed();
          reader.lengthPrefixed();
          break;
        }
        case 9:
          previousLogNumber = reader.varint();
          break;
        default:
          fail(`unknown manifest tag ${tag}`);
      }
    }
  }
  if (required.size > 0) fail("incomplete manifest");
  return { tables: [...tables], logNumber, previousLogNumber };
}

interface VersionedEntry {
  readonly sequence: number;
  readonly value: Uint8Array | null;
}

type EntryMap = Map<string, { readonly key: Uint8Array; readonly entry: VersionedEntry }>;

const keyId = decodeLatin1;

function record(entries: EntryMap, key: Uint8Array, entry: VersionedEntry) {
  const id = keyId(key);
  const existing = entries.get(id);
  if (!existing || existing.entry.sequence < entry.sequence) entries.set(id, { key, entry });
}

function readWriteBatch(entries: EntryMap, batch: Uint8Array) {
  if (batch.length < 12) fail("write batch too short");
  const sequence = readUint32(batch, 0) + readUint32(batch, 4) * 0x100000000;
  const count = readUint32(batch, 8);
  const reader = new Reader(batch, 12);
  for (let index = 0; index < count; index++) {
    const type = reader.byte();
    const key = reader.lengthPrefixed();
    if (type === 1) {
      record(entries, key, { sequence: sequence + index, value: reader.lengthPrefixed() });
    } else if (type === 0) {
      record(entries, key, { sequence: sequence + index, value: null });
    } else {
      fail(`unknown write batch record type ${type}`);
    }
  }
}

function readBlock(table: Uint8Array, reader: Reader): Uint8Array {
  const offset = reader.varint();
  const size = reader.varint();
  if (offset + size + BLOCK_TRAILER_SIZE > table.length) fail("block handle out of range");
  const contents = table.subarray(offset, offset + size);
  const compression = table[offset + size]!;
  const checksum = unmaskCrc(readUint32(table, offset + size + 1));
  if (crc32c(table.subarray(offset, offset + size + 1)) !== checksum) fail("block checksum");
  if (compression === 0) return contents;
  if (compression === 1) return decompressSnappy(contents);
  return fail(`unsupported block compression ${compression}`);
}

function* blockEntries(block: Uint8Array): Generator<[Uint8Array, Uint8Array]> {
  if (block.length < 4) fail("block too short");
  const restartCount = readUint32(block, block.length - 4);
  const limit = block.length - 4 - restartCount * 4;
  if (limit < 0) fail("restart array out of range");
  const reader = new Reader(block.subarray(0, limit));
  let key = new Uint8Array(0);
  while (!reader.done) {
    const shared = reader.varint();
    const unshared = reader.varint();
    const valueLength = reader.varint();
    if (shared > key.length) fail("block key prefix out of range");
    const nextKey = new Uint8Array(shared + unshared);
    nextKey.set(key.subarray(0, shared));
    nextKey.set(reader.take(unshared), shared);
    key = nextKey;
    yield [key, reader.take(valueLength)];
  }
}

function readTable(entries: EntryMap, table: Uint8Array) {
  if (table.length < TABLE_FOOTER_SIZE) fail("table too short");
  const footer = new Reader(table, table.length - TABLE_FOOTER_SIZE);
  footer.varint();
  footer.varint();
  const index = readBlock(table, footer);
  for (const [, handle] of blockEntries(index)) {
    const block = readBlock(table, new Reader(handle));
    for (const [internalKey, value] of blockEntries(block)) {
      if (internalKey.length < 8) fail("internal key too short");
      const trailerOffset = internalKey.length - 8;
      const trailer = readUint32(internalKey, trailerOffset) + readUint32(internalKey, trailerOffset + 4) * 0x100000000;
      const type = trailer % 256;
      const sequence = Math.floor(trailer / 256);
      const key = internalKey.subarray(0, trailerOffset);
      record(entries, key, { sequence, value: type === 1 ? value : null });
    }
  }
}

/** Chromium prefixes each stored string with 0 (UTF-16LE) or 1 (Latin-1). */
function decodeChromiumString(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  const body = bytes.subarray(1);
  if (bytes[0] === 1) return decodeLatin1(body);
  if (bytes[0] === 0 && body.length % 2 === 0) return textDecoderUtf16.decode(body);
  return null;
}

/** The filesystem this reader needs, as little as possible so tests can hand in fixture bytes directly (no real
 * directory, no home dir). Production reads go through desktop/runtime.ts. */
export interface LegacyFs {
  /** `null` for a missing file; any other read failure should throw. */
  readFile(name: string): Promise<Uint8Array | null>;
  readdir(): Promise<string[]>;
}

export class ChromiumLocalStorageReadError extends Error {
  readonly cause: unknown;
  constructor(directory: string, cause: unknown) {
    super(`Could not read Chromium Local Storage at ${directory}.`);
    this.name = "ChromiumLocalStorageReadError";
    this.cause = cause;
  }
}

/** Reads one origin's items out of a Chromium `Local Storage/leveldb` directory. Throws ChromiumLocalStorageReadError
 * on any read/format problem (missing CURRENT included), so the caller can tell "nothing to import" (its own check,
 * before calling this) from "could not read this launch, retry next time". */
export async function readChromiumLocalStorage(fs: LegacyFs, directory: string, origin: string): Promise<Map<string, string>> {
  try {
    const currentBytes = await fs.readFile("CURRENT");
    if (currentBytes === null) throw new LevelDbFormatError("missing CURRENT");
    const current = textDecoderUtf8.decode(currentBytes).trim();
    if (!/^MANIFEST-\d+$/.test(current)) throw new LevelDbFormatError("bad CURRENT");
    const manifestBytes = await fs.readFile(current);
    if (manifestBytes === null) throw new LevelDbFormatError("missing MANIFEST");
    const live = readManifest(manifestBytes);
    const names = await fs.readdir();
    const logs = names
      .map((name) => /^(\d+)\.log$/.exec(name))
      .filter((match) => {
        const number = Number(match?.[1]);
        return number >= live.logNumber || number === live.previousLogNumber;
      })
      .map((match) => match![0]);

    const entries: EntryMap = new Map();
    for (const number of live.tables) {
      const name = String(number).padStart(6, "0");
      // Newer LevelDB names tables .ldb; older databases may still hold .sst files.
      const bytes = (await fs.readFile(`${name}.ldb`)) ?? (await fs.readFile(`${name}.sst`));
      if (bytes === null) throw new LevelDbFormatError(`missing table ${name}`);
      readTable(entries, bytes);
    }
    for (const name of logs) {
      const bytes = await fs.readFile(name);
      if (bytes === null) continue;
      for (const batch of readLogRecords(bytes)) readWriteBatch(entries, batch);
    }

    const prefix = `_${origin}\u0000`;
    const items = new Map<string, string>();
    for (const [id, { key: rawKey, entry }] of entries) {
      if (!id.startsWith(prefix) || entry.value === null) continue;
      const key = decodeChromiumString(rawKey.subarray(prefix.length));
      const value = decodeChromiumString(entry.value);
      if (key !== null && value !== null) items.set(key, value);
    }
    return items;
  } catch (cause) {
    throw new ChromiumLocalStorageReadError(directory, cause);
  }
}
