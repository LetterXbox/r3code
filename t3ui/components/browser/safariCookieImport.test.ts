// Safari's Cookies.binarycookies is not SQLite, so the fixture is built here directly (big-endian file/page headers,
// little-endian record bodies) rather than from a real exported file, matching parseBinaryCookies' own documented
// layout (components/browser/safariCookieImport.ts).
import { expect, test } from "nsh/test";
import { parseBinaryCookies, SafariCookieFormatError } from "./safariCookieImport";

const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;
const FLAG_SECURE = 0x1;
const FLAG_HTTP_ONLY = 0x4;

interface RecordSpec { domain: string; name: string; path: string; value: string; secure?: boolean; httpOnly?: boolean; expiry?: number }

function buildRecord(spec: RecordSpec): Uint8Array {
  const enc = new TextEncoder();
  const domain = enc.encode(`${spec.domain}\0`);
  const name = enc.encode(`${spec.name}\0`);
  const path = enc.encode(`${spec.path}\0`);
  const value = enc.encode(`${spec.value}\0`);
  const urlOffset = 56;
  const nameOffset = urlOffset + domain.length;
  const pathOffset = nameOffset + name.length;
  const valueOffset = pathOffset + path.length;
  const size = valueOffset + value.length;
  const buffer = new Uint8Array(size);
  const view = new DataView(buffer.buffer);
  view.setUint32(0, size, true);
  const flags = (spec.secure ? FLAG_SECURE : 0) | (spec.httpOnly ? FLAG_HTTP_ONLY : 0);
  view.setUint32(8, flags, true);
  view.setUint32(16, urlOffset, true);
  view.setUint32(20, nameOffset, true);
  view.setUint32(24, pathOffset, true);
  view.setUint32(28, valueOffset, true);
  view.setFloat64(40, spec.expiry ?? 0, true);
  buffer.set(domain, urlOffset);
  buffer.set(name, nameOffset);
  buffer.set(path, pathOffset);
  buffer.set(value, valueOffset);
  return buffer;
}

function buildBinaryCookies(records: RecordSpec[]): Uint8Array {
  const built = records.map(buildRecord);
  const headerSize = 12 + built.length * 4;
  const pageSize = headerSize + built.reduce((sum, r) => sum + r.length, 0);
  const page = new Uint8Array(pageSize);
  const pageView = new DataView(page.buffer);
  pageView.setUint32(0, 0x00000100, false);
  pageView.setUint32(4, built.length, true);
  let cursor = headerSize;
  built.forEach((record, index) => {
    pageView.setUint32(8 + index * 4, cursor, true);
    page.set(record, cursor);
    cursor += record.length;
  });

  const fileHeader = new Uint8Array(8 + 4);
  const fileView = new DataView(fileHeader.buffer);
  new TextEncoder().encodeInto("cook", fileHeader);
  fileView.setUint32(4, 1, false);
  fileView.setUint32(8, pageSize, false);

  const trailer = new Uint8Array(8);
  return new Uint8Array([...fileHeader, ...page, ...trailer]);
}

test("parseBinaryCookies: a basic secure+httpOnly cookie round-trips url/domain/path/flags/expiry", () => {
  const bytes = buildBinaryCookies([{ domain: ".example.com", name: "sid", path: "/", value: "plainvalue", secure: true, httpOnly: true, expiry: 100 }]);
  const cookies = parseBinaryCookies(bytes);
  expect(cookies.length).toBe(1);
  const cookie = cookies[0]!;
  expect(cookie.domain).toBe(".example.com");
  expect(cookie.url).toBe("https://example.com/");
  expect(cookie.name).toBe("sid");
  expect(cookie.value).toBe("plainvalue");
  expect(cookie.secure).toBe(true);
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.expirationDate).toBe(100 + APPLE_EPOCH_OFFSET_SECONDS);
});

test("parseBinaryCookies: a non-domain host with no explicit path defaults to '/' and is not a domain cookie", () => {
  const bytes = buildBinaryCookies([{ domain: "example.com", name: "n", path: "", value: "v" }]);
  const cookie = parseBinaryCookies(bytes)[0]!;
  expect(cookie.domain).toBeUndefined();
  expect(cookie.path).toBe("/");
  expect(cookie.url).toBe("http://example.com/");
  expect(cookie.secure).toBe(false);
});

test("parseBinaryCookies: zero expiry is undefined, not the Apple epoch", () => {
  const bytes = buildBinaryCookies([{ domain: "example.com", name: "n", path: "/", value: "v", expiry: 0 }]);
  expect(parseBinaryCookies(bytes)[0]!.expirationDate).toBeUndefined();
});

test("parseBinaryCookies: multiple records in one page all come through", () => {
  const bytes = buildBinaryCookies([
    { domain: "a.example.com", name: "one", path: "/", value: "1" },
    { domain: "b.example.com", name: "two", path: "/x", value: "2" },
  ]);
  const cookies = parseBinaryCookies(bytes);
  expect(cookies.map((c) => c.name)).toEqual(["one", "two"]);
});

test("parseBinaryCookies: a record with an empty domain or name is skipped, not thrown", () => {
  const bytes = buildBinaryCookies([{ domain: "", name: "n", path: "/", value: "v" }]);
  expect(parseBinaryCookies(bytes)).toEqual([]);
});

test("parseBinaryCookies: rejects bytes without the 'cook' magic", () => {
  expect(() => parseBinaryCookies(new Uint8Array(16))).toThrow(SafariCookieFormatError);
});

test("parseBinaryCookies: rejects a truncated page table", () => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setUint32(4, 100, false); // claims 100 pages with no page-size table to back it
  new TextEncoder().encodeInto("cook", bytes);
  expect(() => parseBinaryCookies(bytes)).toThrow(SafariCookieFormatError);
});
