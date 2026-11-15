import { expect, test } from "nsh/test";
import { clearFamilyRemovals, familyRowStillPresent, familyShellGeneration, recordFamilyShellEvent } from "./familyRemovals";

test("only authoritative snapshots advance their environment's family generation", () => {
  const before = familyShellGeneration("generation-a");
  const other = familyShellGeneration("generation-b");
  recordFamilyShellEvent("generation-a", { kind: "snapshot", snapshot: { threads: [] } });
  expect(familyShellGeneration("generation-a")).toBe(before + 1);
  recordFamilyShellEvent("generation-a", { kind: "snapshot", snapshot: {}, resolvedRepositoryIdentityRoots: [] });
  recordFamilyShellEvent("generation-a", { kind: "thread.updated", thread: {} });
  expect(familyShellGeneration("generation-a")).toBe(before + 1);
  expect(familyShellGeneration("generation-b")).toBe(other);
});

test("an authoritative snapshot discards tombstones from the previous sequence baseline", () => {
  clearFamilyRemovals("generation-reset");
  recordFamilyShellEvent("generation-reset", { kind: "thread.removed", threadId: "child", sequence: 100 });
  expect(familyRowStillPresent("generation-reset", "child", 2)).toBe(false);
  recordFamilyShellEvent("generation-reset", { kind: "snapshot", snapshot: { threads: [] } });
  expect(familyRowStillPresent("generation-reset", "child", 2)).toBe(true);
  recordFamilyShellEvent("generation-reset", { kind: "thread.removed", threadId: "child", sequence: 3 });
  expect(familyRowStillPresent("generation-reset", "child", 2)).toBe(false);
});

test("a newer active-shell removal suppresses stale family rows without affecting other environments", () => {
  clearFamilyRemovals("family-a");
  clearFamilyRemovals("family-b");
  recordFamilyShellEvent("family-a", { kind: "thread.removed", location: "active", threadId: "child", sequence: 11 });
  expect(familyRowStillPresent("family-a", "child", 10)).toBe(false);
  expect(familyRowStillPresent("family-a", "child", 11)).toBe(true);
  expect(familyRowStillPresent("family-b", "child", 10)).toBe(true);
  clearFamilyRemovals("family-a");
  expect(familyRowStillPresent("family-a", "child", 0)).toBe(true);
});
