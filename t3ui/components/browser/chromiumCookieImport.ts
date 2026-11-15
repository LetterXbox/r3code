// Chromium cookie import (H6), macOS only: the reference's ChromiumKeys.ts + ChromiumCookies.ts, ported to the runtime
// seam (desktop/runtime.ts) and WebCrypto (the app has no `node:crypto`, but `crypto.subtle` does PBKDF2/AES-CBC/SHA-256).
// The OSCrypt key lives in the macOS Keychain under a per-browser service/account (ChromiumKeys.ts's table), read with
// `/usr/bin/security find-generic-password -w` (already in nsh.json's execute allowlist) instead of a native keyring
// binding, since this app has none. Reading the cookie database itself needs no sqlite engine: the browser must already
// be quit (detectBrowserImportSources' SingletonLock check) so its WAL is checkpointed, and components/browser/
// sqliteRawTable.ts walks the plain file's b-tree in memory.
import type { DesktopRuntime } from "../../desktop/runtime";
import { bareHost, cookieScope, type CookieReadResult, type ImportedCookie } from "./cookieScope";
import { cellByName, readSqliteTable, type SqliteCell } from "./sqliteRawTable";

export type ChromiumKeyFailure = "needsKeychainApproval" | "keychainItemMissing" | "keychainUnavailable" | "readFailed";

export class ChromiumKeyError extends Error {
  readonly reason: ChromiumKeyFailure;
  constructor(reason: ChromiumKeyFailure, cause?: unknown) {
    super(`Could not obtain the Chromium cookie key: ${reason}.`);
    this.name = "ChromiumKeyError";
    this.reason = reason;
    this.cause = cause;
  }
}

const KEY_SALT = "saltysalt";
const KEY_LENGTH_BITS = 128;
const MAC_KEY_ITERATIONS = 1003;
/** OSCrypt's CBC mode uses a fixed IV of 16 spaces rather than a per-record one. */
const AES_CBC_IV = new Uint8Array(16).fill(0x20);

async function deriveKey(secret: string): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new TextEncoder().encode(KEY_SALT), iterations: MAC_KEY_ITERATIONS, hash: "SHA-1" },
    base,
    KEY_LENGTH_BITS,
  );
  return new Uint8Array(bits);
}

/** `security find-generic-password -w -s <service> -a <account>`: the Keychain item's password, or why it could not be read. */
export async function readKeychainSecret(runtime: DesktopRuntime, service: string, account: string): Promise<string> {
  let result;
  try {
    result = await runtime.run("/usr/bin/security", ["find-generic-password", "-w", "-s", service, "-a", account], { timeoutMs: 15000 });
  } catch (cause) {
    throw new ChromiumKeyError("keychainUnavailable", cause);
  }
  if (result.code !== 0) {
    const message = result.stderr || "";
    const missing = /could not be found|item could not be found|not found/i.test(message);
    throw new ChromiumKeyError(missing ? "keychainItemMissing" : "needsKeychainApproval", new Error(message || `security exited ${result.code}`));
  }
  const secret = result.stdout.replace(/\r?\n$/, "");
  if (!secret) throw new ChromiumKeyError("keychainItemMissing");
  return secret;
}

export async function resolveChromiumKey(runtime: DesktopRuntime, keychainService: string, keychainAccount: string): Promise<Uint8Array> {
  const secret = await readKeychainSecret(runtime, keychainService, keychainAccount);
  return deriveKey(secret);
}

/** Chromium 127+ (schema >= 24) prefixes plaintext with the host-key SHA-256 to bind its domain. */
async function stripDomainBinding(plaintext: Uint8Array, domain: string, schemaVersion: number): Promise<Uint8Array | null> {
  if (schemaVersion < 24) return plaintext;
  const domainHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(domain)));
  if (plaintext.length < 32) return null;
  for (let index = 0; index < 32; index++) if (plaintext[index] !== domainHash[index]) return null;
  return plaintext.subarray(32);
}

async function decryptCbc(payload: Uint8Array, key: Uint8Array, domain: string, schemaVersion: number): Promise<string | null> {
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["decrypt"]);
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: AES_CBC_IV }, cryptoKey, payload));
    const stripped = await stripDomainBinding(plaintext, domain, schemaVersion);
    return stripped === null ? null : new TextDecoder().decode(stripped);
  } catch {
    return null;
  }
}

/** decryptChromiumValue, macOS subset only: v10-prefixed CBC, or (legacy, unprefixed) the domain-bound plaintext directly. */
export async function decryptChromiumValueMac(encrypted: Uint8Array, key: Uint8Array, domain: string, schemaVersion: number): Promise<string | null> {
  if (encrypted.length === 0) return "";
  const prefix = new TextDecoder("latin1").decode(encrypted.subarray(0, 3));
  const payload = encrypted.subarray(3);
  if (prefix === "v10") return decryptCbc(payload, key, domain, schemaVersion);
  if (prefix === "v11") return null; // v11 keys are a Linux keyring secret; never produced on macOS.
  const stripped = await stripDomainBinding(encrypted, domain, schemaVersion);
  return stripped === null ? null : new TextDecoder().decode(stripped);
}

const sameSiteFromColumn = (value: number): ImportedCookie["sameSite"] => (value === 0 ? "no_restriction" : value === 1 ? "lax" : value === 2 ? "strict" : "unspecified");

const WEBKIT_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const toUnixSeconds = (webkitSeconds: number): number | undefined => (webkitSeconds <= 0 ? undefined : webkitSeconds - WEBKIT_EPOCH_OFFSET_SECONDS);

const asString = (cell: SqliteCell | undefined): string => (typeof cell === "string" ? cell : cell === null || cell === undefined ? "" : String(cell));
const asNumber = (cell: SqliteCell | undefined): number => (typeof cell === "number" ? cell : typeof cell === "bigint" ? Number(cell) : 0);
const asBlob = (cell: SqliteCell | undefined): Uint8Array => (cell instanceof Uint8Array ? cell : new Uint8Array(0));

/** readChromiumCookieDatabase, macOS subset: `cookies` joined against `meta`'s schema version, already-read bytes in memory. */
export async function readChromiumCookiesFromBytes(bytes: Uint8Array, key: Uint8Array): Promise<CookieReadResult> {
  const meta = readSqliteTable(bytes, "meta");
  const versionRow = meta.rows.find((row) => asString(cellByName(meta.columns, row, "key")) === "version");
  const schemaVersion = versionRow ? Number(asString(cellByName(meta.columns, versionRow, "value"))) || 0 : 0;

  const table = readSqliteTable(bytes, "cookies");
  const hasTopFrameSiteKey = table.columns.includes("top_frame_site_key");

  const cookies: ImportedCookie[] = [];
  let undecryptable = 0;
  const undecryptableHosts = new Set<string>();

  for (const row of table.rows) {
    const hostKey = asString(cellByName(table.columns, row, "host_key"));
    if (hasTopFrameSiteKey && asString(cellByName(table.columns, row, "top_frame_site_key")) !== "") {
      // Partitioned (CHIPS) cookies have no single importable scope; Electron's cookie store has no partition key either.
      undecryptable += 1;
      undecryptableHosts.add(bareHost(hostKey));
      continue;
    }
    const encrypted = asBlob(cellByName(table.columns, row, "encrypted_value"));
    const plainValue = asString(cellByName(table.columns, row, "value"));
    const value = encrypted.length === 0 ? plainValue : await decryptChromiumValueMac(encrypted, key, hostKey, schemaVersion);
    if (value === null) {
      undecryptable += 1;
      undecryptableHosts.add(bareHost(hostKey));
      continue;
    }
    const secure = asNumber(cellByName(table.columns, row, "is_secure")) === 1;
    const path = asString(cellByName(table.columns, row, "path"));
    const scope = cookieScope(hostKey, path, secure);
    cookies.push({
      url: scope.url,
      name: asString(cellByName(table.columns, row, "name")),
      value,
      domain: scope.domain,
      path,
      secure,
      httpOnly: asNumber(cellByName(table.columns, row, "is_httponly")) === 1,
      expirationDate: toUnixSeconds(asNumber(cellByName(table.columns, row, "expires_utc")) / 1_000_000),
      sameSite: sameSiteFromColumn(asNumber(cellByName(table.columns, row, "samesite"))),
    });
  }

  return { cookies, undecryptable, undecryptableHosts: [...undecryptableHosts] };
}

/** readChromiumCookies: resolve the Keychain key, read the already-fetched database bytes, decrypt every row. */
export async function readChromiumCookies(runtime: DesktopRuntime, cookieDatabaseBytes: Uint8Array, keychainService: string, keychainAccount: string): Promise<CookieReadResult> {
  const key = await resolveChromiumKey(runtime, keychainService, keychainAccount);
  return readChromiumCookiesFromBytes(cookieDatabaseBytes, key);
}
