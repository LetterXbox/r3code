// Community colour themes from Open VSX, ported from apps/web/src/openVsxThemes.ts: the search (endpoint,
// parameters, page size and every size and licence guard as the web has them), and the install, which downloads
// the extension package (a .vsix, a ZIP), checks it against the checksum Open VSX publishes, reads its colour
// theme files and turns them into theme definitions with vscodeThemeImport.ts. Requests carry only the search text
// and the extension's public identity: nothing about the user or their projects.
//
// The web opens the package with JSZip; here a small ZIP reader walks the central directory (with the same limits
// the web checks: entry count, expanded size, compression ratio, no ZIP64) and inflates entries with `zlib`.
import { createHash } from "crypto";
import { inflateRawSync } from "zlib";
import { parseJsonc, isVsCodeThemeFile, pairVsCodeThemes, parseVsCodeThemeFile, resolveThemeLabelCollisions } from "./vscodeThemeImport";
import type { ThemeDefinition } from "./themePalette";

const OPEN_VSX_SEARCH_URL = "https://open-vsx.org/api/-/search";
const MAX_VSIX_BYTES = 20 * 1024 * 1024;
const MAX_SEARCH_BYTES = 512 * 1024;
const MAX_DETAIL_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const SEARCH_REQUEST_TIMEOUT_MS = 10_000;
const MAX_THEME_BYTES = 256 * 1024;
const MAX_ZIP_ENTRIES = 5_000;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_THEMES_PER_EXTENSION = 40;
const MAX_INCLUDE_DEPTH = 8;
const MAX_PACKAGE_PATH_LENGTH = 1_024;
const MAX_COLOR_VALUE_LENGTH = 128;
const MAX_RESOLVED_THEME_FILES = MAX_THEMES_PER_EXTENSION * MAX_INCLUDE_DEPTH;
const SUPPORTED_LICENSES = new Set(["0BSD", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "CC0-1.0", "ISC", "MIT", "MPL-2.0", "Unlicense"]);
const USED_WORKBENCH_COLORS = new Set([
  "activityBar.background", "activityBarBadge.background", "badge.background", "button.background", "button.foreground", "contrastBorder",
  "descriptionForeground", "disabledForeground", "dropdown.background", "dropdown.border", "editor.background", "editor.foreground",
  "editor.findMatchBackground", "editor.findMatchForeground", "editor.findMatchHighlightBackground", "editor.findMatchHighlightForeground",
  "editor.selectionBackground", "editorCursor.foreground", "editorError.foreground", "editorGroup.border", "editorPane.background",
  "editorWarning.foreground", "editorWidget.background", "errorForeground", "focusBorder", "foreground", "input.border",
  "input.placeholderForeground", "list.activeSelectionBackground", "list.hoverBackground", "list.inactiveSelectionBackground",
  "menu.background", "panel.background", "panel.border", "progressBar.background", "quickInput.background", "scrollbarSlider.background",
  "sideBar.background", "sideBar.border", "sideBar.foreground", "terminal.background", "terminal.foreground", "terminal.selectionBackground",
  "terminalCursor.foreground", "textCodeBlock.background", "textLink.foreground",
]);

export type OpenVsxThemeSort = "downloadCount" | "rating" | "timestamp" | "relevance";

export interface OpenVsxThemeExtension {
  id: string;
  collectionId: string;
  name: string;
  publisher: string;
  description: string;
  downloadCount: number;
  iconUrl: string | null;
  sourceUrl: string | null;
  manifestUrl: string;
  sha256Url: string;
  vsixUrl: string;
  version: string;
  license: string;
}

export interface OpenVsxThemeSearchOptions {
  signal?: AbortSignal;
  sortBy?: OpenVsxThemeSort;
}

interface ThemeContribution { label?: unknown; uiTheme?: unknown; path?: unknown }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const sha256Of = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const shortHash = (value: string) => sha256Of(value).slice(0, 12);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const abortError = () => {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
};
const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw abortError();
};

function openVsxThemeId(extensionId: string, source: string): string {
  return `ovx-theme-${shortHash(`${extensionId}:${source}`)}`;
}

function openVsxCollectionId(extensionId: string): string {
  const normalized = `open-vsx:${extensionId.toLowerCase()}`;
  return /^[a-z0-9][a-z0-9.:-]{0,127}$/.test(normalized) ? normalized : `open-vsx:${shortHash(extensionId)}`;
}

function trustedOpenVsxUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "open-vsx.org" ? url.toString() : null;
  } catch {
    return null;
  }
}

function publicSourceUrl(value: unknown): string | null {
  const rawValue = typeof value === "string" ? value : isRecord(value) && typeof value.url === "string" ? value.url : null;
  if (!rawValue) return null;
  try {
    const url = new URL(rawValue);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function themeContributions(manifest: Record<string, unknown>): ThemeContribution[] {
  const contributes = isRecord(manifest.contributes) ? manifest.contributes : null;
  return Array.isArray(contributes?.themes) ? (contributes.themes.filter(isRecord) as ThemeContribution[]) : [];
}

function manifestLicenseMatches(manifest: Record<string, unknown>, license: string): boolean {
  return typeof manifest.license === "string" && manifest.license.trim().toLowerCase() === license.toLowerCase();
}

function extensionFromDetail(value: unknown): OpenVsxThemeExtension | null {
  if (!isRecord(value) || !isRecord(value.files)) throw new Error("Open VSX returned malformed theme details.");
  const namespace = typeof value.namespace === "string" ? value.namespace.trim() : "";
  const extensionName = typeof value.name === "string" ? value.name.trim() : "";
  const displayName = (typeof value.displayName === "string" ? value.displayName.trim() : "") || extensionName;
  const version = typeof value.version === "string" ? value.version.trim() : "";
  const license = typeof value.license === "string" ? value.license.trim() : "";
  const manifestUrl = trustedOpenVsxUrl(value.files.manifest);
  const sha256Url = trustedOpenVsxUrl(value.files.sha256);
  const vsixUrl = trustedOpenVsxUrl(value.files.download);
  if (!namespace || !extensionName || !version || !manifestUrl || !sha256Url || !vsixUrl) throw new Error("Open VSX returned malformed theme details.");
  if (!SUPPORTED_LICENSES.has(license)) return null;
  const id = `${namespace}.${extensionName}`;
  return {
    id,
    collectionId: openVsxCollectionId(id),
    name: displayName,
    publisher: namespace,
    description: typeof value.description === "string" ? value.description : "",
    downloadCount: typeof value.downloadCount === "number" && Number.isFinite(value.downloadCount) ? value.downloadCount : 0,
    iconUrl: trustedOpenVsxUrl(value.files.icon),
    sourceUrl: publicSourceUrl(value.repository) ?? publicSourceUrl(value.homepage) ?? publicSourceUrl(value.url),
    manifestUrl,
    sha256Url,
    vsixUrl,
    version,
    license,
  };
}

async function withSearchTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, SEARCH_REQUEST_TIMEOUT_MS);
  try {
    return await operation(controller.signal);
  } catch (cause) {
    if (controller.signal.aborted && !parentSignal?.aborted) throw new Error("Open VSX took too long to respond.");
    throw cause;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abort);
  }
}

async function readCappedResponse(response: Response, limit: number, tooLargeMessage: string): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > limit) throw new Error(tooLargeMessage);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new Error(tooLargeMessage);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > limit) {
        await reader.cancel();
        throw new Error(tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function parseJsoncObject(source: string, description: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = parseJsonc(source);
  } catch {
    throw new Error(`${description} is not valid JSON.`);
  }
  if (!isRecord(value)) throw new Error(`${description} is not valid JSON.`);
  return value;
}

export async function searchOpenVsxThemes(query: string, { signal, sortBy = "downloadCount" }: OpenVsxThemeSearchOptions = {}): Promise<OpenVsxThemeExtension[]> {
  const searchText = query.trim();
  if (!searchText) return [];
  const url = new URL(OPEN_VSX_SEARCH_URL);
  url.searchParams.set("query", searchText);
  url.searchParams.set("category", "Themes");
  url.searchParams.set("sortBy", sortBy);
  url.searchParams.set("sortOrder", "desc");
  url.searchParams.set("size", "16");
  const value = await withSearchTimeout(async (requestSignal) => {
    const response = await fetch(url, { signal: requestSignal });
    if (!response.ok) throw new Error("Open VSX search is unavailable right now.");
    const searchBytes = await readCappedResponse(response, MAX_SEARCH_BYTES, "Open VSX returned an unexpectedly large response.");
    try {
      return JSON.parse(decode(searchBytes)) as unknown;
    } catch {
      throw new Error("Open VSX returned an unreadable response.");
    }
  }, signal);
  if (!isRecord(value) || !Array.isArray(value.extensions)) throw new Error("Open VSX returned an unreadable search response.");
  const identities = value.extensions.flatMap((candidate): [string, string][] => {
    if (!isRecord(candidate)) return [];
    const namespace = typeof candidate.namespace === "string" ? candidate.namespace : "";
    const name = typeof candidate.name === "string" ? candidate.name : "";
    return namespace && name ? [[namespace, name]] : [];
  });
  const details = await Promise.allSettled(
    identities.slice(0, 16).map(([namespace, name]) =>
      withSearchTimeout(async (requestSignal) => {
        const detailUrl = `https://open-vsx.org/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
        const detailResponse = await fetch(detailUrl, { signal: requestSignal });
        if (!detailResponse.ok) throw new Error("Open VSX theme details are unavailable.");
        const detailBytes = await readCappedResponse(detailResponse, MAX_DETAIL_BYTES, "Open VSX returned an unexpectedly large detail response.");
        try {
          const extension = extensionFromDetail(JSON.parse(decode(detailBytes)));
          if (!extension) return null;
          const [manifestResponse, packageResponse] = await Promise.all([
            fetch(extension.manifestUrl, { signal: requestSignal }),
            fetch(extension.vsixUrl, { method: "HEAD", signal: requestSignal }),
          ]);
          if (!manifestResponse.ok) throw new Error("manifest unavailable");
          if (!packageResponse.ok) return null;
          const packageLength = Number(packageResponse.headers.get("content-length"));
          if (Number.isFinite(packageLength) && packageLength > MAX_VSIX_BYTES) return null;
          const manifestBytes = await readCappedResponse(manifestResponse, MAX_MANIFEST_BYTES, "Open VSX returned an unexpectedly large manifest.");
          const manifest = parseJsoncObject(decode(manifestBytes), "Extension manifest");
          return themeContributions(manifest).length > 0 && manifestLicenseMatches(manifest, extension.license) ? extension : null;
        } catch {
          throw new Error("Open VSX returned unreadable theme details.");
        }
      }, signal),
    ),
  );
  if (signal?.aborted) throw abortError();
  const completedDetails = details.filter((result): result is PromiseFulfilledResult<OpenVsxThemeExtension | null> => result.status === "fulfilled");
  if (identities.length > 0 && completedDetails.length === 0) throw new Error("Open VSX theme details are unavailable right now.");
  return completedDetails.flatMap((result) => (result.value ? [result.value] : [])).slice(0, 8);
}

// --- the package -------------------------------------------------------------------------------------------

function sanitizeThemeObject(value: Record<string, unknown>): Record<string, unknown> {
  const colors: Record<string, string> = {};
  if (isRecord(value.colors)) {
    for (const [key, color] of Object.entries(value.colors)) {
      if (USED_WORKBENCH_COLORS.has(key) && typeof color === "string" && color.length <= MAX_COLOR_VALUE_LENGTH) colors[key] = color;
    }
  }
  return { ...(typeof value.include === "string" ? { include: value.include } : {}), colors };
}

function normalizePackagePath(path: string, relativeTo = "extension/"): string {
  if (path.length > MAX_PACKAGE_PATH_LENGTH || path.includes("\0") || path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
    throw new Error("Theme path is not a safe relative package path.");
  }
  const normalizedInput = path.replaceAll("\\", "/");
  const segments = relativeTo.split("/").slice(0, -1);
  for (const segment of normalizedInput.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length <= 1) throw new Error("Theme path escapes the extension package.");
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments[0] !== "extension") segments.unshift("extension");
  return segments.join("/");
}

function contributionType(uiTheme: unknown): string | null {
  if (uiTheme === "vs") return "light";
  if (uiTheme === "vs-dark") return "dark";
  if (uiTheme === "hc-black" || uiTheme === "hc-light") return uiTheme;
  return null;
}

interface ZipEntry { name: string; method: number; compressedSize: number; size: number; offset: number }

/** The package's central directory, after the web's checks: entry count, expanded size, compression ratio, no ZIP64. */
function readZipDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumOffset = Math.max(0, bytes.byteLength - 65_557);
  let endOffset = bytes.byteLength - 22;
  while (endOffset >= minimumOffset && (view.getUint32(endOffset, true) !== 0x06054b50 || endOffset + 22 + view.getUint16(endOffset + 20, true) !== bytes.byteLength)) {
    endOffset -= 1;
  }
  if (endOffset < minimumOffset) throw new Error("That extension package has no ZIP directory.");
  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  const directoryEnd = directoryOffset + directorySize;
  if (directoryEnd !== endOffset || directoryEnd > bytes.byteLength) throw new Error("That extension package has an invalid ZIP directory.");

  const entries = new Map<string, ZipEntry>();
  let entryCount = 0;
  let totalUncompressed = 0;
  let offset = directoryOffset;
  while (offset < directoryEnd) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== 0x02014b50) throw new Error("That extension package has an invalid ZIP directory.");
    entryCount += 1;
    if (entryCount > MAX_ZIP_ENTRIES) throw new Error("That extension package has too many files.");
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) throw new Error("That extension package has unsupported ZIP64 metadata.");
    totalUncompressed += uncompressed;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error("That extension package expands beyond the safe import limit.");
    if (uncompressed > 0 && (compressed === 0 || uncompressed / compressed > MAX_COMPRESSION_RATIO)) throw new Error("That extension package has an unsafe compression ratio.");
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (offset + 46 + nameLength > directoryEnd) throw new Error("That extension package has an invalid ZIP directory.");
    const name = decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.set(name, { name, method, compressedSize: compressed, size: uncompressed, offset: localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== directoryEnd) throw new Error("That extension package has an invalid ZIP directory.");
  // The web refuses a package with a path that does not stay inside it.
  for (const name of entries.keys()) normalizePackagePath(name);
  return entries;
}

interface Zip { bytes: Uint8Array; entries: Map<string, ZipEntry> }

function readZipText(zip: Zip, path: string, description: string, signal?: AbortSignal): string {
  throwIfAborted(signal);
  const entry = zip.entries.get(path);
  if (!entry) throw new Error(`${description} is missing from the extension package.`);
  if (entry.size > MAX_THEME_BYTES) throw new Error(`${description} is too large.`);
  const view = new DataView(zip.bytes.buffer, zip.bytes.byteOffset, zip.bytes.byteLength);
  if (entry.offset + 30 > zip.bytes.byteLength || view.getUint32(entry.offset, true) !== 0x04034b50) throw new Error(`${description} has unreadable size metadata.`);
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const data = zip.bytes.subarray(start, start + entry.compressedSize);
  if (data.byteLength !== entry.compressedSize) throw new Error(`${description} has unreadable size metadata.`);
  let out: Uint8Array;
  if (entry.method === 0) out = data;
  else if (entry.method === 8) {
    try {
      out = inflateRawSync(data, { maxOutputLength: MAX_THEME_BYTES });
    } catch {
      throw new Error(`${description} is too large.`);
    }
  } else throw new Error(`${description} has unreadable size metadata.`);
  if (out.byteLength > MAX_THEME_BYTES) throw new Error(`${description} is too large.`);
  return decode(out);
}

function loadThemeObject(zip: Zip, path: string, cache: Map<string, Record<string, unknown>>, budget: { files: number }, ancestors: ReadonlySet<string> = new Set(), signal?: AbortSignal): Record<string, unknown> {
  throwIfAborted(signal);
  if (ancestors.size >= MAX_INCLUDE_DEPTH) throw new Error("Theme includes are nested too deeply.");
  if (ancestors.has(path)) throw new Error("Theme includes contain a cycle.");
  const cached = cache.get(path);
  if (cached) return cached;
  budget.files += 1;
  if (budget.files > MAX_RESOLVED_THEME_FILES) throw new Error("That extension references too many theme files.");
  const value = sanitizeThemeObject(parseJsoncObject(readZipText(zip, path, path, signal), path));
  if (typeof value.include !== "string") {
    cache.set(path, value);
    return value;
  }
  const includePath = normalizePackagePath(value.include, path);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(path);
  const base = loadThemeObject(zip, includePath, cache, budget, nextAncestors, signal);
  const resolved = {
    ...base,
    ...value,
    colors: { ...(isRecord(base.colors) ? base.colors : {}), ...(isRecord(value.colors) ? value.colors : {}) },
  };
  cache.set(path, resolved);
  return resolved;
}

async function fetchPackage(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) throw new Error("That Open VSX theme could not be downloaded.");
  return readCappedResponse(response, MAX_VSIX_BYTES, "That theme extension is too large to import safely.");
}

export type ImportedOpenVsxTheme = ThemeDefinition & { collection: { id: string; label: string } };

export async function importOpenVsxThemeExtension(extension: OpenVsxThemeExtension, signal?: AbortSignal): Promise<ImportedOpenVsxTheme[]> {
  const manifestResponse = await fetch(extension.manifestUrl, signal ? { signal } : {});
  if (!manifestResponse.ok) throw new Error("That Open VSX extension has no readable manifest.");
  const manifestBytes = await readCappedResponse(manifestResponse, MAX_MANIFEST_BYTES, "That Open VSX extension manifest is too large.");
  const manifest = parseJsoncObject(decode(manifestBytes), "Extension manifest");
  const advertisedContributions = themeContributions(manifest);
  if (advertisedContributions.length === 0) throw new Error("That extension does not contain color themes.");
  if (advertisedContributions.length > MAX_THEMES_PER_EXTENSION) throw new Error("That extension contains too many color themes to import safely.");

  const packageBytes = await fetchPackage(extension.vsixUrl, signal);
  throwIfAborted(signal);
  const checksumResponse = await fetch(extension.sha256Url, signal ? { signal } : {});
  if (!checksumResponse.ok) throw new Error("That Open VSX theme has no readable checksum.");
  const expectedChecksum = decode(await readCappedResponse(checksumResponse, 256, "That Open VSX checksum response is invalid.")).trim().split(/\s+/)[0];
  if (!expectedChecksum || !/^[a-f\d]{64}$/i.test(expectedChecksum)) throw new Error("That Open VSX theme has an invalid checksum.");
  throwIfAborted(signal);
  if (sha256Of(packageBytes).toLowerCase() !== expectedChecksum.toLowerCase()) throw new Error("That Open VSX theme failed its integrity check.");
  throwIfAborted(signal);
  let zip: Zip;
  try {
    zip = { bytes: packageBytes, entries: readZipDirectory(packageBytes) };
  } catch (cause) {
    if (cause instanceof Error && (cause.message.startsWith("That extension package") || cause.message.startsWith("Theme path"))) throw cause;
    throw new Error("That Open VSX extension package could not be opened.");
  }

  const packagedManifest = parseJsoncObject(readZipText(zip, "extension/package.json", "Extension manifest", signal), "Extension manifest");
  if (
    typeof packagedManifest.publisher !== "string" ||
    packagedManifest.publisher.toLowerCase() !== extension.publisher.toLowerCase() ||
    typeof packagedManifest.name !== "string" ||
    `${packagedManifest.publisher}.${packagedManifest.name}`.toLowerCase() !== extension.id.toLowerCase() ||
    packagedManifest.version !== extension.version
  ) {
    throw new Error("That extension package does not match the selected Open VSX theme.");
  }
  if (!manifestLicenseMatches(packagedManifest, extension.license)) throw new Error("That extension package does not match its advertised license.");
  const contributions = themeContributions(packagedManifest);
  if (contributions.length === 0) throw new Error("That extension does not contain color themes.");
  if (contributions.length > MAX_THEMES_PER_EXTENSION) throw new Error("That extension contains too many color themes to import safely.");

  const parsed: { theme: ThemeDefinition; sourceName: string; sourcePath: string }[] = [];
  const failures: string[] = [];
  const themeCache = new Map<string, Record<string, unknown>>();
  const themeBudget = { files: 0 };
  for (const contribution of contributions) {
    throwIfAborted(signal);
    if (typeof contribution.path !== "string") {
      failures.push("theme path is missing");
      continue;
    }
    try {
      const path = normalizePackagePath(contribution.path);
      const themeValue = loadThemeObject(zip, path, themeCache, themeBudget, new Set(), signal);
      const type = contributionType(contribution.uiTheme);
      const label = typeof contribution.label === "string" && contribution.label.trim() ? contribution.label.trim() : extension.name;
      const decorated = { ...themeValue, displayName: label, ...(type ? { type } : {}) };
      if (!isVsCodeThemeFile(decorated)) throw new Error("not a VS Code color theme");
      parsed.push({ theme: parseVsCodeThemeFile(decorated), sourceName: path.split("/").at(-1)!, sourcePath: path });
    } catch (cause) {
      throwIfAborted(signal);
      failures.push(cause instanceof Error ? cause.message : "theme could not be read");
    }
  }
  if (failures.length > 0) throw new Error("One or more color themes in that extension could not be imported safely.");
  if (parsed.length === 0) throw new Error("That extension has no compatible color themes.");
  const extensionId = extension.id.toLowerCase();
  const sourcePathCounts = new Map<string, number>();
  for (const { sourcePath } of parsed) sourcePathCounts.set(sourcePath, (sourcePathCounts.get(sourcePath) ?? 0) + 1);
  const sourcePathOccurrences = new Map<string, number>();
  const sourceIdentities = parsed.map(({ sourcePath }) => {
    if (sourcePathCounts.get(sourcePath) === 1) return sourcePath;
    const occurrence = sourcePathOccurrences.get(sourcePath) ?? 0;
    sourcePathOccurrences.set(sourcePath, occurrence + 1);
    return occurrence === 0 ? sourcePath : `${sourcePath}\0${occurrence}`;
  });
  const resolved = resolveThemeLabelCollisions(parsed).map((theme, index) => ({ ...theme, id: openVsxThemeId(extensionId, sourceIdentities[index]!) }));
  const paired = pairVsCodeThemes(resolved, { pairedId: (light, dark) => openVsxThemeId(extensionId, [light.id, dark.id].sort().join(":")) });
  const themes = resolveThemeLabelCollisions(paired.map((theme) => ({ theme })));
  const collection = { id: extension.collectionId, label: extension.name.slice(0, 48) };
  return themes.map((theme) => ({ ...theme, collection }));
}
