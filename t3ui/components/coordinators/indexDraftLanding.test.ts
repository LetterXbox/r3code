import { expect, test } from "nsh/test";
import { applyShellEventForTest, setBackendStatusForTest, type Project } from "../../store";
import { draftStartFailed, mostRecentProject, resetIndexDraftLanding, retryDraftStart, runIndexDraftLanding } from "./indexDraftLanding";

const project = (id: string, name: string, threadTimes: number[], updatedAt = 0): Project => ({
  id, name, updatedAt,
  threads: threadTimes.map((time, index) => ({ id: `${id}-${index}`, projectId: id, title: "t", status: "idle", pinned: false, updatedAt: time })),
});

test("the most recent project is the one with the latest thread activity, pinned or not, ties by name", () => {
  expect(mostRecentProject([project("old", "Old", [10]), project("recent", "Recent", [50]), project("empty", "Empty", [], 20)])?.id).toBe("recent");
  expect(mostRecentProject([{ ...project("b", "B", [5]), pinned: true }, project("a", "A", [5])])?.id).toBe("a");
  expect(mostRecentProject([])).toBe(null);
});

test("with projects but no thread open, the landing starts one draft per attempt", () => {
  resetIndexDraftLanding();
  setBackendStatusForTest("connected");
  applyShellEventForTest({ kind: "snapshot", snapshot: { projects: [{ id: "p", title: "P" }, { id: "gone", title: "Gone", archivedAt: "2026-02-01T00:00:00Z" }], threads: [] } });
  const started: string[] = [];
  expect(runIndexDraftLanding((id) => started.push(id))).toBe(true);
  expect(runIndexDraftLanding((id) => started.push(id))).toBe(false);
  expect(started).toEqual(["p"]);
});

test("a failed start shows the error until Try again asks for another attempt", () => {
  resetIndexDraftLanding();
  setBackendStatusForTest("connected");
  applyShellEventForTest({ kind: "snapshot", snapshot: { projects: [{ id: "p", title: "P" }], threads: [] } });
  expect(runIndexDraftLanding(() => { throw new Error("no"); })).toBe(false);
  expect(draftStartFailed()).toBe(true);
  expect(runIndexDraftLanding(() => undefined)).toBe(false);
  retryDraftStart();
  expect(draftStartFailed()).toBe(false);
  const started: string[] = [];
  expect(runIndexDraftLanding((id) => started.push(id))).toBe(true);
  expect(started).toEqual(["p"]);
});
