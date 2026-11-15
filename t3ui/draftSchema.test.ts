import { expect, test } from "nsh/test";
import { DRAFT_STORAGE_VERSION, readVersionedDrafts, withDraftVersion } from "./draftSchema";

test("saved drafts carry the schema version and round-trip", () => {
  const saved = withDraftVersion({ "http://a": { drafts: {} } });
  expect(saved.__version).toBe(DRAFT_STORAGE_VERSION);
  expect(readVersionedDrafts(saved)).toEqual({ "http://a": { drafts: {} } });
});

test("an unversioned store is migrated and a different version is rejected", () => {
  expect(readVersionedDrafts({ "http://a": 1 })).toEqual({ "http://a": 1 });
  expect(readVersionedDrafts({ __version: DRAFT_STORAGE_VERSION - 1, "http://a": 1 })).toBeNull();
  expect(readVersionedDrafts({ __version: DRAFT_STORAGE_VERSION + 1, "http://a": 1 })).toBeNull();
});
