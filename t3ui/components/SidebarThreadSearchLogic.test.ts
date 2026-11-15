import { expect, test } from "nsh/test";
import { activeSearchIndex, moveSearchHighlight, parseSidebarMessageMatches } from "./SidebarThreadSearchLogic";

test("search results retain the matching thread and excerpt", async () => {
  const matches = parseSidebarMessageMatches({ matches: [{
    threadId: "thread:1", projectId: "project:1", source: "assistant", snippet: "A matching passage", messageId: "message:1",
  }] });
  await expect(matches[0].threadId).toBe("thread:1");
  await expect(matches[0].snippet).toBe("A matching passage");
  await expect(matches[0].messageId).toBe("message:1");
  const legacy = parseSidebarMessageMatches({ matches: [
    { threadId: "thread:2", projectId: "project:1", source: "user", snippet: "A match" },
    { threadId: "thread:3", projectId: "project:1", source: "user", snippet: "A match", messageId: null },
  ] });
  await expect(legacy[0].messageId).toBe(null);
  await expect(legacy[1].messageId).toBe(null);
});

test("search rejects malformed server responses", () => {
  expect(() => parseSidebarMessageMatches({})).toThrow("invalid search results");
  expect(() => parseSidebarMessageMatches({ matches: [{ threadId: "one", source: "user" }] })).toThrow("invalid search results");
  expect(() => parseSidebarMessageMatches({ matches: [{ threadId: "one", projectId: "p", source: "system", snippet: "" }] })).toThrow("invalid search results");
  expect(() => parseSidebarMessageMatches({ matches: [{ threadId: "one", projectId: "p", source: "user", snippet: "", messageId: 42 }] })).toThrow("invalid search results");
});

test("the highlight starts at the top and follows its thread", () => {
  expect(activeSearchIndex(["a", "b", "c"], null)).toBe(0);
  expect(activeSearchIndex(["a", "b", "c"], "c")).toBe(2);
  expect(activeSearchIndex(["a", "b", "c"], "gone")).toBe(0);
  expect(activeSearchIndex(["x", "a", "b"], "b")).toBe(2);
});

test("up and down move the highlight and wrap", () => {
  const keys = ["a", "b", "c"];
  expect(moveSearchHighlight(keys, null, 1)).toBe("b");
  expect(moveSearchHighlight(keys, "c", 1)).toBe("a");
  expect(moveSearchHighlight(keys, null, -1)).toBe("c");
  expect(moveSearchHighlight(keys, "b", -1)).toBe("a");
  expect(moveSearchHighlight([], null, 1)).toBe(null);
});
