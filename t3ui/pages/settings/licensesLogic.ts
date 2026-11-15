// The third-party license manifest, ported from packages/shared/src/thirdPartyLicenses.ts and the
// loader in components/settings/OpenSourceLicenses.tsx: a static asset the server hosts next to the
// web app (`/third-party-licenses.json`), decoded strictly, filtered by every word of the query.

export interface ThirdPartyLicenseEntry {
  bundles: string[];
  kind: "custom" | "package";
  license: string;
  name: string;
  noticeText: string;
  sourceUrl: string | null;
  version: string | null;
}

export interface ThirdPartyLicenseManifest { schemaVersion: 1; entries: ThirdPartyLicenseEntry[] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function decodeEntry(value: unknown, index: number): ThirdPartyLicenseEntry {
  if (!isRecord(value)) throw new Error(`License entry ${String(index + 1)} is not an object.`);
  if (
    !isStringArray(value.bundles) || value.bundles.length === 0 ||
    (value.kind !== "custom" && value.kind !== "package") ||
    typeof value.license !== "string" || typeof value.name !== "string" || typeof value.noticeText !== "string" ||
    (value.sourceUrl !== null && !isHttpUrl(value.sourceUrl)) ||
    (value.version !== null && typeof value.version !== "string")
  ) throw new Error(`License entry ${String(index + 1)} has an invalid shape.`);
  return { bundles: value.bundles, kind: value.kind, license: value.license, name: value.name, noticeText: value.noticeText, sourceUrl: value.sourceUrl, version: value.version };
}

export function thirdPartyLicenseEntryKey(entry: ThirdPartyLicenseEntry): string {
  return encodeURIComponent(JSON.stringify([entry.kind, entry.name, entry.version]));
}

export function decodeThirdPartyLicenseManifest(value: unknown): ThirdPartyLicenseManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.entries)) {
    throw new Error("The open-source license manifest has an unsupported format.");
  }
  const entries = value.entries.map(decodeEntry);
  const keys = new Set<string>();
  for (const entry of entries) {
    const key = thirdPartyLicenseEntryKey(entry);
    if (keys.has(key)) throw new Error(`The open-source license manifest contains a duplicate entry: ${key}`);
    keys.add(key);
  }
  return { schemaVersion: 1, entries };
}

export function filterThirdPartyLicenseEntries(entries: readonly ThirdPartyLicenseEntry[], query: string): readonly ThirdPartyLicenseEntry[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) return entries;
  return entries.filter((entry) => {
    const searchable = [entry.name, entry.version, entry.license, ...entry.bundles]
      .filter((value): value is string => value !== null)
      .join(" ")
      .toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

const BUNDLE_LABELS: Readonly<Record<string, string>> = {
  android: "Android", assets: "Assets", desktop: "Desktop", "device-tools": "Device tools", ios: "iOS", mobile: "Mobile", server: "Server", web: "Web",
};

export function formatLicenseBundles(bundles: readonly string[]): string {
  return bundles.map((bundle) => (Object.prototype.hasOwnProperty.call(BUNDLE_LABELS, bundle) ? BUNDLE_LABELS[bundle] : bundle)).join(", ");
}

/** "<n> notices", or "<shown> of <n>" while a search narrows the list (LicenseCount). */
export const licenseCountLabel = (filtered: number, total: number) => (filtered === total ? `${String(total)} notices` : `${String(filtered)} of ${String(total)}`);

export const LICENSE_TIMEOUT_MESSAGE = "The license manifest took too long to load.";
export const LICENSE_FALLBACK_MESSAGE = "The license manifest could not load.";

/** Loads and decodes the manifest from `url`; a non-2xx answer and a 30 second wait fail with the web's messages. */
export async function loadLicenseManifest(url: string, timeoutMs = 30_000, fetcher: typeof fetch = fetch): Promise<ThirdPartyLicenseManifest> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetcher(url, { signal: controller.signal });
    if (response.status < 200 || response.status >= 300) throw new Error(`The license manifest request failed with status ${String(response.status)}.`);
    return decodeThirdPartyLicenseManifest(await response.json());
  } catch (cause) {
    if (timedOut) throw new Error(LICENSE_TIMEOUT_MESSAGE);
    throw new Error(cause instanceof Error && cause.message ? cause.message : LICENSE_FALLBACK_MESSAGE);
  } finally {
    clearTimeout(timer);
  }
}

/** Where the server hosts the manifest: its HTTP origin (ws://host:port becomes http://host:port), `/third-party-licenses.json`. */
export function licenseManifestUrl(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    url.protocol = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
    url.pathname = "/third-party-licenses.json";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
