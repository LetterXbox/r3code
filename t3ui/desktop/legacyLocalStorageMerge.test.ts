import { expect, test } from "nsh/test";
import { mergeLegacyDraftsIntoLocal, mergeLegacyPromptStash, parseLegacyComposerDrafts } from "./legacyLocalStorageMerge";

interface Entry { id: string; createdAt: string; prompt: string }
const MAX_ENTRIES = 20;
const legacyStash = (...entries: Entry[]) => JSON.stringify({ version: 2, state: { entries } });

test("mergeLegacyPromptStash appends legacy entries the port does not already have", () => {
  const current: Entry[] = [{ id: "keep", createdAt: "t", prompt: "current" }];
  const merged = mergeLegacyPromptStash(current, legacyStash({ id: "legacy-1", createdAt: "t", prompt: "old prompt" }), MAX_ENTRIES);
  expect(merged).not.toBeNull();
  expect(merged!.map((entry) => entry.id)).toEqual(["keep", "legacy-1"]);
});

test("mergeLegacyPromptStash skips ids the port already has and returns null when nothing is added", () => {
  const current: Entry[] = [{ id: "shared", createdAt: "t", prompt: "current wins" }];
  const merged = mergeLegacyPromptStash(current, legacyStash({ id: "shared", createdAt: "t", prompt: "legacy" }), MAX_ENTRIES);
  expect(merged).toBeNull();
});

test("mergeLegacyPromptStash caps the merged list at the port's max entries, current entries never evicted", () => {
  const current: Entry[] = Array.from({ length: 20 }, (_, index) => ({ id: `cur-${index}`, createdAt: "t", prompt: "x" }));
  const merged = mergeLegacyPromptStash(current, legacyStash({ id: "legacy-1", createdAt: "t", prompt: "y" }), MAX_ENTRIES);
  expect(merged).toBeNull(); // Nothing fits; the cap drops the added entry entirely rather than evicting a current one.
});

test("mergeLegacyPromptStash returns null for unparsable JSON", () => {
  expect(mergeLegacyPromptStash([], "not json", MAX_ENTRIES)).toBeNull();
});

const legacyDrafts = (version: number, draftsByThreadKey: Record<string, { prompt: string }>) => JSON.stringify({ version, state: { draftsByThreadKey } });

test("parseLegacyComposerDrafts keeps only the local environment's non-empty drafts", () => {
  const raw = legacyDrafts(9, {
    "local:thread-1": { prompt: "local draft" },
    "ssh-host:thread-2": { prompt: "remote draft, not imported" },
    "local:thread-3": { prompt: "" },
  });
  const parsed = parseLegacyComposerDrafts(raw);
  expect(parsed).toEqual([{ threadId: "thread-1", prompt: "local draft" }]);
});

test("parseLegacyComposerDrafts refuses a version mismatch instead of guessing at the shape", () => {
  const raw = legacyDrafts(8, { "local:thread-1": { prompt: "draft" } });
  expect(parseLegacyComposerDrafts(raw)).toBeNull();
});

test("parseLegacyComposerDrafts returns null for malformed JSON or a missing draftsByThreadKey", () => {
  expect(parseLegacyComposerDrafts("not json")).toBeNull();
  expect(parseLegacyComposerDrafts(JSON.stringify({ version: 9, state: {} }))).toBeNull();
});

test("mergeLegacyDraftsIntoLocal fills in missing thread drafts without overwriting the port's own draft", () => {
  const current = { "thread-1": "port draft (wins)" };
  const merged = mergeLegacyDraftsIntoLocal(current, [
    { threadId: "thread-1", prompt: "legacy, should not win" },
    { threadId: "thread-2", prompt: "legacy, new" },
  ]);
  expect(merged).toEqual({ "thread-1": "port draft (wins)", "thread-2": "legacy, new" });
});

test("mergeLegacyDraftsIntoLocal returns null when every thread already has a draft", () => {
  const current = { "thread-1": "port draft" };
  expect(mergeLegacyDraftsIntoLocal(current, [{ threadId: "thread-1", prompt: "legacy" }])).toBeNull();
});
