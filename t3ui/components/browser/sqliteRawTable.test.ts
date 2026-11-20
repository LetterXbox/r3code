// Fixtures are real SQLite databases (built with python3's sqlite3 module, not hand-crafted bytes) so the b-tree
// walker is exercised against an actual file layout. CHROMIUM_FIXTURE: a `meta` table (version=24) and a `cookies`
// table with one plaintext row and one partitioned (top_frame_site_key set) row. FIREFOX_FIXTURE: `moz_cookies`
// with user_version=13.
import { expect, test } from "nsh/test";
import { cellByName, isSqliteHeader, parseTableColumns, readSqliteTable, readSqliteUserVersion } from "./sqliteRawTable";
import { CHROMIUM_FIXTURE_BASE64, FIREFOX_FIXTURE_BASE64 } from "./cookieImportFixtures";

const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

test("isSqliteHeader recognizes the magic string and rejects short or wrong input", () => {
  expect(isSqliteHeader(bytes(CHROMIUM_FIXTURE_BASE64))).toBe(true);
  expect(isSqliteHeader(new Uint8Array(4))).toBe(false);
  expect(isSqliteHeader(new TextEncoder().encode("not a sqlite file at all, padded"))).toBe(false);
});

test("readSqliteTable: chromium fixture's cookies table comes back with every declared column, in order", () => {
  const table = readSqliteTable(bytes(CHROMIUM_FIXTURE_BASE64), "cookies");
  expect(table.columns).toEqual([
    "creation_utc", "host_key", "top_frame_site_key", "name", "value", "encrypted_value",
    "path", "expires_utc", "is_secure", "is_httponly", "samesite",
  ]);
  expect(table.rows.length).toBe(2);
  const first = table.rows[0]!;
  expect(cellByName(table.columns, first, "host_key")).toBe(".example.com");
  expect(cellByName(table.columns, first, "name")).toBe("sid");
  expect(cellByName(table.columns, first, "value")).toBe("plainvalue");
  expect(cellByName(table.columns, first, "encrypted_value")).toEqual(new Uint8Array(0));
  expect(cellByName(table.columns, first, "is_secure")).toBe(1);
  expect(cellByName(table.columns, first, "is_httponly")).toBe(1);
  expect(cellByName(table.columns, first, "samesite")).toBe(1);
});

test("readSqliteTable: chromium fixture's meta table carries the schema version", () => {
  const table = readSqliteTable(bytes(CHROMIUM_FIXTURE_BASE64), "meta");
  const row = table.rows.find((r) => cellByName(table.columns, r, "key") === "version");
  expect(cellByName(table.columns, row!, "value")).toBe("24");
});

test("readSqliteTable: an unknown table name returns an empty scan rather than throwing", () => {
  expect(readSqliteTable(bytes(CHROMIUM_FIXTURE_BASE64), "nope")).toEqual({ columns: [], rows: [] });
});

test("readSqliteTable: firefox fixture's moz_cookies table, including the originAttributes row", () => {
  const table = readSqliteTable(bytes(FIREFOX_FIXTURE_BASE64), "moz_cookies");
  expect(table.rows.length).toBe(3);
  const byName = (name: string) => table.rows.find((r) => cellByName(table.columns, r, "name") === name)!;
  expect(cellByName(table.columns, byName("other"), "originAttributes")).toBe("^userContextId=1");
  expect(cellByName(table.columns, byName("session"), "host")).toBe(".example.org");
  expect(cellByName(table.columns, byName("strict_cookie"), "sameSite")).toBe(2);
});

test("readSqliteUserVersion: firefox fixture reports 13 (Firefox's cookie schema lives in the header, not a table)", () => {
  expect(readSqliteUserVersion(bytes(FIREFOX_FIXTURE_BASE64))).toBe(13);
});

test("readSqliteTable and readSqliteUserVersion reject bytes that are not a SQLite database", () => {
  const junk = new Uint8Array(120).fill(0x20);
  expect(() => readSqliteTable(junk, "cookies")).toThrow("This is not a readable SQLite database.");
  expect(() => readSqliteUserVersion(junk)).toThrow("This is not a readable SQLite database.");
});

test("parseTableColumns: quoted, bracketed and backtick-quoted names, constraints and generated columns are skipped", () => {
  expect(parseTableColumns('CREATE TABLE t ("a b" TEXT, [c] INTEGER, `d` BLOB, PRIMARY KEY(a), e TEXT GENERATED ALWAYS AS (1))'))
    .toEqual(["a b", "c", "d"]);
});
