// The message search's text rules (paletteSearch.ts): which words the server searches messages for, and where they fall in a snippet.
import { expect, test } from "nsh/test";
import { canSearchThreadMessages, findSearchTokenRanges, messageSearchTokens, normalizeThreadSearchQuery, splitSearchText } from "./searchHighlight";
import { excerptParts } from "../SidebarThreadSearch";

test("messages are searched from a word of three letters; two Chinese characters count", () => {
  expect(canSearchThreadMessages("ab")).toBe(false);
  expect(canSearchThreadMessages("ab cd")).toBe(false);
  expect(canSearchThreadMessages("ab cde")).toBe(true);
  expect(canSearchThreadMessages("你好")).toBe(true);
  expect(messageSearchTokens('"Fix sidebar"').long).toEqual(["fix", "sidebar"]);
});

test("a pasted wall of text searches by its first 200 characters", () => {
  expect(normalizeThreadSearchQuery("  hi  ")).toBe("hi");
  expect(normalizeThreadSearchQuery("x".repeat(500)).length).toBe(200);
});

test("the excerpt sets the query's words apart, ignoring case and accents", () => {
  const parts = excerptParts("Fixed the Sidebar résumé bug", "sidebar RESUME");
  expect(parts.filter((part) => part.highlighted).map((part) => part.text)).toEqual(["Sidebar", "résumé"]);
  expect(parts.map((part) => part.text).join("")).toBe("Fixed the Sidebar résumé bug");
});

test("a short token only counts at the start of a word", () => {
  expect(findSearchTokenRanges("fix drafts", "fts")).toEqual([]);
  expect(findSearchTokenRanges("fts drafts", "fts")).toEqual([{ start: 0, end: 3 }]);
  expect(splitSearchText("abc", [])).toEqual([{ text: "abc", highlighted: false, start: 0 }]);
});
