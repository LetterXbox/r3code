import { expect, test } from "nsh/test";
import { MAX_STASH_ENTRIES, addEntry, parseStoredEntries, removeEntry, restoredPrompt, stashEntrySnippet } from "./promptStash";

const entry = (id: string, prompt = id) => ({ id, createdAt: "2026-01-01T00:00:00.000Z", prompt });

test("the stash lists the newest first and drops the oldest beyond 20", () => {
  let list: ReturnType<typeof addEntry>["entries"] = [];
  for (let n = 0; n < MAX_STASH_ENTRIES; n += 1) list = addEntry(list, entry(`e${n}`)).entries;
  expect(list[0]?.id).toBe("e19");
  const overflow = addEntry(list, entry("new"));
  expect(overflow.entries.length).toBe(MAX_STASH_ENTRIES);
  expect(overflow.entries[0]?.id).toBe("new");
  expect(overflow.evicted?.id).toBe("e0");
});

test("taking an entry removes it, and the snippet is one line cut at 90 characters", () => {
  const list = [entry("a", "first"), entry("b", "second")];
  const taken = removeEntry(list, "a");
  expect(taken.entry?.id).toBe("a");
  expect(taken.entries.map((item) => item.id)).toEqual(["b"]);
  expect(removeEntry(list, "zzz").entry).toBe(null);
  expect(stashEntrySnippet({ prompt: "  line one\n\n  line   two " })).toBe("line one line two");
  expect(stashEntrySnippet({ prompt: "" })).toBe("(empty)");
  const long = "x".repeat(120);
  expect(stashEntrySnippet({ prompt: long })).toBe(`${"x".repeat(90)}…`);
});

test("restoring appends to a draft that already has text, after a blank line", () => {
  expect(restoredPrompt("", "stashed")).toBe("stashed");
  expect(restoredPrompt("  \n", "stashed")).toBe("stashed");
  expect(restoredPrompt("draft  \n", "stashed")).toBe("draft\n\nstashed");
  expect(restoredPrompt("draft", "")).toBe("draft");
});

test("saved entries load back, ignoring anything malformed", () => {
  const raw = JSON.stringify([entry("a"), { id: 1 }, entry("b")]);
  expect(parseStoredEntries(raw).map((item) => item.id)).toEqual(["a", "b"]);
  expect(parseStoredEntries("{not json")).toEqual([]);
  expect(parseStoredEntries(null)).toEqual([]);
});

test("an entry keeps the draft's uploaded attachments, drops the bytes when persisted, and names them when the prompt is empty", async () => {
  const { stashPrompt, stashEntries, resetStashForTests, stashEntrySnippet, parseStoredEntries } = await import("./promptStash");
  resetStashForTests();
  const attachment = { id: "a1", name: "shot.png", mimeType: "image/png", sizeBytes: 10, kind: "image" as const, status: "uploaded" as const, uploadedId: "att-1" };
  stashPrompt("", 1, [attachment, { ...attachment, id: "a2", name: "n.txt", kind: "file", mimeType: "text/plain", uploadedId: "att-2" }]);
  const entry = stashEntries()[0]!;
  expect(entry.attachments?.map((item) => item.uploadedId)).toEqual(["att-1", "att-2"]);
  expect(stashEntrySnippet(entry)).toBe("(2 attachments)");
  expect(stashEntrySnippet({ prompt: "", attachments: [attachment] })).toBe("(1 image)");
  const stored = parseStoredEntries(JSON.stringify([{ ...entry, attachments: entry.attachments }]));
  expect(stored[0]?.attachments?.[0]).toMatchObject({ id: "a1", uploadedId: "att-1", kind: "image" });
});

test("fm13: a stash keeps the composer's context records and reads them back", async () => {
  const { stashPromptDurably, parseStoredEntries, stashEntries, resetStashForTests } = await import("./promptStash");
  resetStashForTests();
  const record = { version: 1, kind: "thread", contextId: "ctx_1", label: "T", environmentId: "e", threadId: "t", title: "Thread" };
  const result = await stashPromptDurably("hello", 0, [], [record]);
  expect(result.written).toBe(true);
  expect(stashEntries()[0]?.records).toEqual([record]);
  expect(parseStoredEntries(JSON.stringify([{ id: "s", createdAt: "x", prompt: "p", records: [record, { nope: 1 }] }]))[0]?.records).toEqual([record]);
});
