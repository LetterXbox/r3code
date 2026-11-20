// H6 orchestrator: resolves a browser import source's cookie database, reads and decrypts it with the matching engine
// module, and reports failures the way browserImportWizardLogic.importFailureReason expects to parse them back out of
// an IPC-style Error (`Importing cookies from <id> failed: <reason>.`, BrowserImport.ts's BrowserImportFailedError
// message shape). Writing the decrypted cookies into a preview webview's own cookie store is a separate, still-unverified
// step: see writeImportedCookies below and third_party/nsh-host-patches/0022-gpui-webview-cookie-store.patch.
import { host } from "nsh";
import type { DesktopRuntime } from "../../desktop/runtime";
import { desktopHostCapabilities } from "../../desktop/desktopHost";
import { cookieCandidates, type Definition } from "./browserImportDetect";
import type { CookieReadResult, ImportedCookie } from "./cookieScope";
import { ChromiumKeyError, readChromiumCookiesFromBytes, resolveChromiumKey } from "./chromiumCookieImport";
import { readFirefoxCookiesFromBytes } from "./firefoxCookieImport";
import { parseBinaryCookies, SafariCookieFormatError } from "./safariCookieImport";
import type { BrowserImportFailureReason } from "../../pages/settings/browserImportWizardLogic";

export class BrowserCookieImportError extends Error {
  readonly reason: BrowserImportFailureReason;
  constructor(sourceId: string, reason: BrowserImportFailureReason, cause?: unknown) {
    // Matches BrowserImportFailedError's message (reference BrowserImport.ts) so importFailureReason() keeps working unchanged.
    super(`Importing cookies from ${sourceId} failed: ${reason}.`);
    this.name = "BrowserCookieImportError";
    this.reason = reason;
    this.cause = cause;
  }
}

/** Re-resolves the one existing candidate path for a profile (Chromium jars may be under Network/, else the profile root). */
export async function resolveCookieDatabasePath(runtime: DesktopRuntime, def: Definition, home: string, directory: string): Promise<string | undefined> {
  const root = def.root(home);
  for (const candidate of cookieCandidates(def.engine, root, directory)) {
    if ((await runtime.fileSize(candidate)) !== null) return candidate;
  }
  return undefined;
}

/** Safari: `stat`-equivalent (fileSize) succeeds without Full Disk Access; only an actual read proves TCC granted it. */
async function readSafari(runtime: DesktopRuntime, sourceId: string, path: string): Promise<CookieReadResult> {
  let bytes: Uint8Array;
  try {
    bytes = await runtime.readFile(path);
  } catch (cause) {
    const code = (cause as { code?: string } | undefined)?.code;
    throw new BrowserCookieImportError(sourceId, code === "EPERM" ? "needsFullDiskAccess" : "readFailed", cause);
  }
  try {
    return { cookies: parseBinaryCookies(bytes), undecryptable: 0, undecryptableHosts: [] };
  } catch (cause) {
    if (cause instanceof SafariCookieFormatError) throw new BrowserCookieImportError(sourceId, "readFailed", cause);
    throw cause;
  }
}

async function readFirefox(runtime: DesktopRuntime, sourceId: string, path: string): Promise<CookieReadResult> {
  let bytes: Uint8Array;
  try {
    bytes = await runtime.readFile(path);
  } catch (cause) {
    throw new BrowserCookieImportError(sourceId, "readFailed", cause);
  }
  try {
    return { cookies: readFirefoxCookiesFromBytes(bytes), undecryptable: 0, undecryptableHosts: [] };
  } catch (cause) {
    throw new BrowserCookieImportError(sourceId, "readFailed", cause);
  }
}

async function readChromium(runtime: DesktopRuntime, sourceId: string, def: Definition, path: string): Promise<CookieReadResult> {
  if (!def.keychainService || !def.keychainAccount) throw new BrowserCookieImportError(sourceId, "unsupportedPlatform");
  let key: Uint8Array;
  try {
    key = await resolveChromiumKey(runtime, def.keychainService, def.keychainAccount);
  } catch (cause) {
    if (cause instanceof ChromiumKeyError) throw new BrowserCookieImportError(sourceId, cause.reason, cause);
    throw new BrowserCookieImportError(sourceId, "keychainUnavailable", cause);
  }
  let bytes: Uint8Array;
  try {
    bytes = await runtime.readFile(path);
  } catch (cause) {
    throw new BrowserCookieImportError(sourceId, "readFailed", cause);
  }
  try {
    return await readChromiumCookiesFromBytes(bytes, key);
  } catch (cause) {
    throw new BrowserCookieImportError(sourceId, "readFailed", cause);
  }
}

/** readSourceCookies: resolves the profile's database then reads it with the matching engine. */
export async function readSourceCookies(runtime: DesktopRuntime, def: Definition, home: string, sourceProfileDirectory: string): Promise<CookieReadResult> {
  const path = await resolveCookieDatabasePath(runtime, def, home, sourceProfileDirectory);
  if (path === undefined) throw new BrowserCookieImportError(def.id, "readFailed");
  if (def.engine === "safari") return readSafari(runtime, def.id, path);
  if (def.engine === "firefox") return readFirefox(runtime, def.id, path);
  return readChromium(runtime, def.id, def, path);
}

export interface CookieWriteResult { imported: number; skipped: number; skippedDomains: string[] }

const cookieHost = (url: string): string => { try { return new URL(url).hostname; } catch { return url; } };

/**
 * writeImportedCookies: the reference writes into Electron's `session.cookies.set` for the destination profile's
 * partition (BrowserImport.ts writeCookies). NSH's WKWebView has no equivalent exposed today (grepped
 * third_party/nsh-host-src: no WKHTTPCookieStore/WKWebsiteDataStore binding, and the CDP shim's `Network.*` methods
 * are stubbed with `{}`, patch 0019). This calls a capability-gated host function so a host that implements
 * third_party/nsh-host-patches/0022-gpui-webview-cookie-store.patch works without a further code change; on a host
 * that does not (every host today), it throws `BrowserCookieImportError(..., "sessionUnavailable")` with a message
 * that says exactly that, rather than silently reporting zero cookies imported.
 */
export async function writeImportedCookies(sourceId: string, read: CookieReadResult, partition: string): Promise<CookieWriteResult> {
  const skippedDomains = new Set(read.undecryptableHosts);
  let skipped = read.undecryptable;
  if (read.cookies.length === 0) return { imported: 0, skipped, skippedDomains: [...skippedDomains].slice(0, 20) };

  if (!(await desktopHostCapabilities()).has("webview.cookies.set")) {
    throw new BrowserCookieImportError(
      sourceId,
      "sessionUnavailable",
      new Error("This build's NSH host cannot write cookies into a preview webview's cookie store (needs nsh-host-patches/0022-gpui-webview-cookie-store.patch); cookies were read and decrypted but not written."),
    );
  }

  let imported = 0;
  for (const cookie of read.cookies as ReadonlyArray<ImportedCookie>) {
    try {
      await host.call("webview.cookies.set", { partition, cookie }, { timeout: 5000 });
      imported += 1;
    } catch {
      skipped += 1;
      skippedDomains.add(cookieHost(cookie.url));
    }
  }
  return { imported, skipped, skippedDomains: [...skippedDomains].slice(0, 20) };
}

export const resolveWritePartition = (environmentId: string, profileId: string | undefined): string =>
  profileId === undefined || profileId === "default" ? environmentId : JSON.stringify([environmentId, profileId]);
