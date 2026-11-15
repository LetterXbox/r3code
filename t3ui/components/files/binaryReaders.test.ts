import { expect, test } from "nsh/test";
import { gunzipSync, gzipSync } from "zlib";
import { archiveFolderRows, archiveFormat, archiveParentFolder, openArchive } from "./archiveReader";
import { base64Bytes, SQLITE_BASE64, TGZ_BASE64, ZIP_BASE64 } from "./binaryFixtures";
import { openSqlite, parseCreateTable } from "./sqliteReader";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("archive formats come from the name", () => {
  expect(archiveFormat("a.ZIP")).toBe("zip");
  expect(archiveFormat("lib.jar")).toBe("zip");
  expect(archiveFormat("a.tar.gz")).toBe("tgz");
  expect(archiveFormat("a.tgz")).toBe("tgz");
  expect(archiveFormat("log.gz")).toBe("gz");
  expect(archiveFormat("a.tar")).toBe("tar");
  expect(archiveFormat("a.7z")).toBe(null);
});

test("a zip lists its entries and reads one", () => {
  const archive = openArchive("s.zip", base64Bytes(ZIP_BASE64));
  expect(archive.entries.map((entry) => entry.path).sort()).toEqual(["a.txt", "d/b.md"]);
  expect(archive.entries.find((entry) => entry.path === "a.txt")?.size).toBe(10);
  expect(archive.entries[0]?.modified).toMatch(/^2026-/);
  expect(text(archive.read("a.txt"))).toBe("hello zip\n");
  expect(text(archive.read("d/b.md"))).toBe("inner\n");
  expect(() => archive.read("missing")).toThrow("This archive entry is unavailable.");
});

test("a tgz and the tar inside it list directories and files", () => {
  const tgz = openArchive("s.tgz", base64Bytes(TGZ_BASE64));
  expect(tgz.entries.map((entry) => `${entry.path}${entry.directory ? " (dir)" : ""}`)).toEqual(["a.txt", "d/ (dir)", "d/b.md"]);
  expect(text(tgz.read("d/b.md"))).toBe("inner\n");
  const tar = gunzipSync(base64Bytes(TGZ_BASE64));
  const plain = openArchive("s.tar", new Uint8Array(tar.buffer, tar.byteOffset, tar.length));
  expect(plain.entries.length).toBe(3);
  expect(text(plain.read("a.txt"))).toBe("hello zip\n");
});

test("a bare .gz is one entry and a damaged archive says so", () => {
  const tar = gunzipSync(base64Bytes(TGZ_BASE64));
  const single = openArchive("notes.txt.gz", new Uint8Array(gzipSync(new TextEncoder().encode("plain text"))));
  expect(single.entries.map((entry) => entry.path)).toEqual(["notes.txt"]);
  expect(text(single.read("notes.txt"))).toBe("plain text");
  expect(() => openArchive("x.zip", new Uint8Array([1, 2, 3, 4, 5]))).toThrow("This is not a readable ZIP archive.");
  expect(() => openArchive("x.tar", new Uint8Array(tar.buffer, tar.byteOffset, 100).slice().fill(7))).toThrow();
});

test("an archive folder shows its next path parts, folders first", () => {
  const entries = [
    { path: "src/a.ts", size: 5, modified: null, directory: false },
    { path: "src/lib/b.ts", size: 7, modified: null, directory: false },
    { path: "src/lib/c.ts", size: 3, modified: null, directory: false },
    { path: "readme.md", size: 9, modified: null, directory: false },
  ];
  expect(archiveFolderRows(entries, "").map((row) => `${row.path}${row.directory ? "/" : ""}:${row.size}`)).toEqual(["src/:15", "readme.md:9"]);
  expect(archiveFolderRows(entries, "src/").map((row) => `${row.path}${row.directory ? "/" : ""}`)).toEqual(["src/lib/", "src/a.ts"]);
  expect(archiveParentFolder("src/lib/")).toBe("src/");
  expect(archiveParentFolder("src/")).toBe("");
});

test("create table statements give their columns and the rowid alias", () => {
  expect(parseCreateTable("CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, body TEXT, PRIMARY KEY (id))")).toEqual({ columns: ["id", "title", "body"], rowidColumn: 0 });
  expect(parseCreateTable('CREATE TABLE "a ""b""" (x, y TEXT, z INTEGER DEFAULT 3, UNIQUE (x, y))').columns).toEqual(["x", "y", "z"]);
  expect(parseCreateTable("CREATE TABLE t (a INT, b TEXT GENERATED ALWAYS AS (a || 'x'), c TEXT)").columns).toEqual(["a", "c"]);
});

test("a database lists its tables with counts and reads rows a page at a time", () => {
  const db = openSqlite(base64Bytes(SQLITE_BASE64));
  expect(db.tables).toEqual([{ name: 'a "b"', count: 2 }, { name: "empty_t", count: 0 }, { name: "notes", count: 120 }]);
  const first = db.rows("notes", 0);
  expect(first.columns).toEqual(["id", "title", "body", "score", "data"]);
  expect(first.rows.length).toBe(50);
  expect(first.rows[0]).toEqual(["1", "note 1", "body 1", "1.5", "NULL"]);
  expect(first.rows[1]?.[4]).toBe("[blob: 4 bytes]");
  // Row 7 holds 3000 characters, which sit on overflow pages and are cut to 1,024.
  expect(first.rows[6]?.[2]?.length).toBe(1024);
  expect(db.rows("notes", 2).rows.map((row) => row[0])).toEqual(Array.from({ length: 20 }, (_value, index) => String(101 + index)));
  expect(db.rows("notes", 3).rows).toEqual([]);
  expect(db.rows('a "b"', 0).rows).toEqual([["1", "one", "NULL"], ["t", "two", "9"]]);
  expect(db.rows("empty_t", 0).rows).toEqual([]);
  expect(() => db.rows("nope", 0)).toThrow("This table is unavailable.");
  expect(() => openSqlite(new Uint8Array(200))).toThrow("This is not a readable SQLite database.");
});
