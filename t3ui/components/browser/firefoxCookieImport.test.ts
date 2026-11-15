import { expect, test } from "nsh/test";
import { readFirefoxCookiesFromBytes } from "./firefoxCookieImport";
import { FIREFOX_FIXTURE_BASE64 } from "./cookieImportFixtures";

const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

test("readFirefoxCookiesFromBytes: excludes rows with a non-empty originAttributes (containers/private windows)", () => {
  const cookies = readFirefoxCookiesFromBytes(bytes(FIREFOX_FIXTURE_BASE64));
  expect(cookies.map((c) => c.name).sort()).toEqual(["session", "strict_cookie"]);
});

test("readFirefoxCookiesFromBytes: a leading-dot host becomes a domain cookie; url/path/secure come from cookieScope", () => {
  const cookies = readFirefoxCookiesFromBytes(bytes(FIREFOX_FIXTURE_BASE64));
  const session = cookies.find((c) => c.name === "session")!;
  expect(session.domain).toBe(".example.org");
  expect(session.url).toBe("https://example.org/");
  expect(session.secure).toBe(true);
  expect(session.httpOnly).toBe(true);
  expect(session.value).toBe("abc123");
});

test("readFirefoxCookiesFromBytes: sameSite=lax with rawSameSite=none (schema 10-14) reports unspecified, not lax", () => {
  const cookies = readFirefoxCookiesFromBytes(bytes(FIREFOX_FIXTURE_BASE64));
  expect(cookies.find((c) => c.name === "session")!.sameSite).toBe("unspecified");
});

test("readFirefoxCookiesFromBytes: an explicit strict sameSite/rawSameSite pair reports strict", () => {
  const cookies = readFirefoxCookiesFromBytes(bytes(FIREFOX_FIXTURE_BASE64));
  const strict = cookies.find((c) => c.name === "strict_cookie")!;
  expect(strict.sameSite).toBe("strict");
  expect(strict.domain).toBeUndefined();
  expect(strict.url).toBe("http://strict.example.com/p");
  expect(strict.secure).toBe(false);
});

test("readFirefoxCookiesFromBytes: a zero expiry is undefined, not epoch zero", () => {
  const cookies = readFirefoxCookiesFromBytes(bytes(FIREFOX_FIXTURE_BASE64));
  expect(cookies.find((c) => c.name === "strict_cookie")!.expirationDate).toBeUndefined();
  expect(cookies.find((c) => c.name === "session")!.expirationDate).toBe(99999999999);
});
