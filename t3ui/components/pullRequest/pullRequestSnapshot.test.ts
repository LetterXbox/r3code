import { Storage } from "nsh";
import { expect, test } from "nsh/test";
import { readPullRequestSnapshot, writePullRequestSnapshot } from "./pullRequestSnapshot";

test("restores a bounded snapshot without storing credentials, errors or cursors", async () => {
  const scope = "snapshot-test-secret-bearer";
  await writePullRequestSnapshot(scope, {
    entries: [{ projectId: "p", repository: "o/r", number: 1, title: "Fix", url: "https://example.com/1", author: { login: "me" }, unexpected: "not-for-storage" }],
    errors: [{ projectTitle: "p", message: "temporary" }], nextCursors: { p: "old-cursor" }, viewers: {}, providers: [],
  });
  const restored = await readPullRequestSnapshot(scope);
  expect(restored?.entries[0]?.author).toBe("me");
  expect(restored?.errors).toEqual([]);
  expect(restored?.nextCursors).toEqual({});
  expect(await readPullRequestSnapshot("other-connection")).toBe(null);
  const raw = await Storage.getItem("r3.pullRequests.snapshots.v1");
  expect(raw?.includes(scope)).toBe(false);
  expect(raw?.includes("old-cursor")).toBe(false);
  expect(raw?.includes("not-for-storage")).toBe(false);
});

test("keeps the eight most recent scopes and recovers from invalid storage", async () => {
  await Storage.setItem("r3.pullRequests.snapshots.v1", "invalid JSON");
  const answer = {
    entries: [{ projectId: "p", repository: "o/r", number: 1, title: "Fix", url: "https://example.com/1" }],
    errors: [], nextCursors: {}, viewers: {}, providers: [],
  };
  for (let index = 0; index < 9; index++) await writePullRequestSnapshot(`eviction-${index}`, answer);
  expect(await readPullRequestSnapshot("eviction-0")).toBe(null);
  expect((await readPullRequestSnapshot("eviction-8"))?.entries.length).toBe(1);
  const raw = await Storage.getItem("r3.pullRequests.snapshots.v1");
  expect(JSON.parse(raw ?? "[]").length).toBe(8);
});
