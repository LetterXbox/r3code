import { expect, test } from "nsh/test";
import { assetUrlFor, isProjectFaviconFallbackUrl, parseProjectIcon } from "./projectIcon";

test("a monogram, an emoji and a lucide icon parse with their colours", () => {
  expect(parseProjectIcon({ kind: "monogram", text: "QZ", color: "teal" })).toEqual({ kind: "monogram", text: "QZ", color: "teal" });
  expect(parseProjectIcon({ kind: "emoji", emoji: "x" })).toEqual({ kind: "emoji", emoji: "x" });
  expect(parseProjectIcon({ kind: "lucide", name: "rocket", color: "rose" })).toEqual({ kind: "lucide", name: "rocket", color: "rose" });
});

test("the older lucide icon with a monogram reads as a monogram", () => {
  expect(parseProjectIcon({ kind: "lucide", name: "folder", color: "blue", monogramText: "AB" })).toEqual({ kind: "monogram", text: "AB", color: "blue" });
});

test("unknown kinds, bad colours and empty values are no override", () => {
  expect(parseProjectIcon(null)).toBe(null);
  expect(parseProjectIcon({ kind: "image", url: "https://example.com/a.png" })).toBe(null);
  expect(parseProjectIcon({ kind: "monogram", text: "AB", color: "chartreuse" })).toBe(null);
  expect(parseProjectIcon({ kind: "emoji", emoji: "  " })).toBe(null);
  expect(parseProjectIcon({ kind: "lucide", name: "", color: "red" })).toBe(null);
});

test("the server's missing-favicon marker is not an image", () => {
  expect(isProjectFaviconFallbackUrl("/api/assets/abc/project-favicon-missing")).toBe(true);
  expect(isProjectFaviconFallbackUrl("/api/assets/abc/favicon.png")).toBe(false);
  expect(isProjectFaviconFallbackUrl(null)).toBe(false);
});

test("an asset URL is built on the environment's HTTP origin and nowhere else", () => {
  expect(assetUrlFor("ws://127.0.0.1:3773/ws", "/api/assets/a/b.png")).toBe("http://127.0.0.1:3773/api/assets/a/b.png");
  expect(assetUrlFor("wss://host.example/ws", "/api/assets/a")).toBe("https://host.example/api/assets/a");
  expect(assetUrlFor("ws://127.0.0.1:3773/ws", "//evil.example/api/assets/a")).toBe(null);
  expect(assetUrlFor("ws://127.0.0.1:3773/ws", "/other/path")).toBe(null);
  expect(assetUrlFor("ftp://x", "/api/assets/a")).toBe(null);
});
