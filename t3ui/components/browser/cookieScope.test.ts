import { expect, test } from "nsh/test";
import { bareHost, cookieScope } from "./cookieScope";

test("bareHost strips a leading dot (domain cookie marker) only", () => {
  expect(bareHost(".example.com")).toBe("example.com");
  expect(bareHost("example.com")).toBe("example.com");
  expect(bareHost(".")).toBe("");
});

test("cookieScope: a plain host-only cookie has no domain and an https url when secure", () => {
  expect(cookieScope("example.com", "/", true)).toEqual({ url: "https://example.com/", domain: undefined });
  expect(cookieScope("example.com", "/a/b", false)).toEqual({ url: "http://example.com/a/b", domain: undefined });
});

test("cookieScope: a leading-dot host is a domain cookie and keeps the dot in `domain`", () => {
  expect(cookieScope(".example.com", "/", true)).toEqual({ url: "https://example.com/", domain: ".example.com" });
});

test("cookieScope: an IPv6 host is bracketed in the URL authority but not in `domain`", () => {
  expect(cookieScope("::1", "/", false)).toEqual({ url: "http://[::1]/", domain: undefined });
  expect(cookieScope(".fe80::1", "/p", true)).toEqual({ url: "https://[fe80::1]/p", domain: ".fe80::1" });
});

test("cookieScope: an already-bracketed IPv6 host is left alone", () => {
  expect(cookieScope("[::1]", "/", false)).toEqual({ url: "http://[::1]/", domain: undefined });
});
