// Firefox cookie import (H6): the reference's FirefoxCookies.ts. Firefox stores cookies in `moz_cookies` unencrypted
// (only saved logins use the master-password-protected NSS store, which cookies never touch), so this is a plain table
// read with sqliteRawTable.ts — no key material needed.
import { cookieScope, type ImportedCookie } from "./cookieScope";
import { cellByName, readSqliteTable, readSqliteUserVersion, type SqliteCell } from "./sqliteRawTable";

/** Unset and unknown SameSite values stay unspecified; mapping them to None would permit cross-site use. */
const SAMESITE_NONE = 0;
const SAMESITE_LAX = 1;
const SAMESITE_STRICT = 2;
/** Schemas 10-14 defaulted sameSite to Lax; rawSameSite preserves the declared value until migration. */
const FIREFOX_RAW_SAMESITE_FIRST_SCHEMA = 10;
const FIREFOX_RAW_SAMESITE_LAST_SCHEMA = 14;
/** Schema 16+ stores expiry in milliseconds; older schemas use seconds. */
const FIREFOX_EXPIRY_MILLISECONDS_SCHEMA = 16;

const sameSiteFromColumn = (value: number | null, rawValue: number | null): ImportedCookie["sameSite"] => {
  if (value === null) return "unspecified";
  if (value === SAMESITE_LAX && rawValue === SAMESITE_NONE) return "unspecified";
  if (value === SAMESITE_NONE) return "no_restriction";
  if (value === SAMESITE_LAX) return "lax";
  if (value === SAMESITE_STRICT) return "strict";
  return "unspecified";
};

const expiryToSeconds = (expiry: number, schemaVersion: number): number | undefined => (expiry <= 0 ? undefined : schemaVersion >= FIREFOX_EXPIRY_MILLISECONDS_SCHEMA ? Math.floor(expiry / 1000) : expiry);

const asString = (cell: SqliteCell | undefined): string => (typeof cell === "string" ? cell : cell === null || cell === undefined ? "" : String(cell));
const asNumber = (cell: SqliteCell | undefined): number => (typeof cell === "number" ? cell : typeof cell === "bigint" ? Number(cell) : 0);
const asNumberOrNull = (cell: SqliteCell | undefined): number | null => (cell === null || cell === undefined ? null : asNumber(cell));

export function readFirefoxCookiesFromBytes(bytes: Uint8Array): ReadonlyArray<ImportedCookie> {
  const schemaVersion = readSqliteUserVersion(bytes);
  const table = readSqliteTable(bytes, "moz_cookies");
  const hasRawSameSite = table.columns.includes("rawSameSite");
  const hasOriginAttributes = table.columns.includes("originAttributes");

  const cookies: ImportedCookie[] = [];
  for (const row of table.rows) {
    // Electron cannot represent Firefox containers/private windows; importing them would collapse distinct sessions.
    if (hasOriginAttributes && asString(cellByName(table.columns, row, "originAttributes")) !== "") continue;
    const secure = asNumber(cellByName(table.columns, row, "isSecure")) === 1;
    const path = asString(cellByName(table.columns, row, "path"));
    const host = asString(cellByName(table.columns, row, "host"));
    const scope = cookieScope(host, path, secure);
    const sameSiteRaw = asNumberOrNull(cellByName(table.columns, row, "sameSite"));
    const rawSameSite = hasRawSameSite && schemaVersion >= FIREFOX_RAW_SAMESITE_FIRST_SCHEMA && schemaVersion <= FIREFOX_RAW_SAMESITE_LAST_SCHEMA
      ? asNumberOrNull(cellByName(table.columns, row, "rawSameSite"))
      : null;
    cookies.push({
      url: scope.url,
      name: asString(cellByName(table.columns, row, "name")),
      value: asString(cellByName(table.columns, row, "value")),
      domain: scope.domain,
      path,
      secure,
      httpOnly: asNumber(cellByName(table.columns, row, "isHttpOnly")) === 1,
      expirationDate: expiryToSeconds(asNumber(cellByName(table.columns, row, "expiry")), schemaVersion),
      sameSite: sameSiteFromColumn(sameSiteRaw, rawSameSite),
    });
  }
  return cookies;
}
