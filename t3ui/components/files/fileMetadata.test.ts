import { expect, test } from "nsh/test";
import { setRequestBackendForTest } from "../../store";
import { FILESYSTEM_READ_SCOPE, overrideSessionScope } from "../../backend/sessionScopes";
import { changedCheckpointPaths, fileMetadata, invalidateFileMetadata, invalidateWrittenFile, resetFileMetadataForTest } from "./fileMetadata";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("metadata is asked once per absolute path, only with filesystem:read, and asked again after invalidation", async () => {
  resetFileMetadataForTest();
  const asked: unknown[] = [];
  setRequestBackendForTest(async (method, payload) => { asked.push([method, payload]); return { entries: [{ kind: "file", byteLength: 2048, mimeType: "text/plain" }] }; });
  overrideSessionScope(FILESYSTEM_READ_SCOPE, "denied");
  expect(fileMetadata("src/a.ts", "/repo")).toBe(null);
  expect(asked).toHaveLength(0);
  overrideSessionScope(FILESYSTEM_READ_SCOPE, "granted");
  expect(fileMetadata("//host/share/a", "/repo")).toBe(null);
  expect(fileMetadata("src/a.ts", null)).toBe(null);
  expect(fileMetadata("src/a.ts", "/repo")).toBe(null);
  await tick();
  expect(fileMetadata("src/a.ts:12", "/repo")).toEqual({ kind: "file", byteLength: 2048, mimeType: "text/plain" });
  expect(asked).toEqual([["filesystem.getMetadata", { paths: ["/repo/src/a.ts"] }]]);
  invalidateFileMetadata(["/repo/src/a.ts"]);
  expect(fileMetadata("src/a.ts", "/repo")).toBe(null);
  await tick();
  expect(asked).toHaveLength(2);
  setRequestBackendForTest(null);
  overrideSessionScope(FILESYSTEM_READ_SCOPE, null);
  resetFileMetadataForTest();
});

test("a miss or an answer is asked again once a minute has passed, not before", async () => {
  let clock = 1000;
  resetFileMetadataForTest(() => clock);
  const asked: unknown[] = [];
  let reply: unknown = { entries: [null] };
  setRequestBackendForTest(async (method, payload) => { asked.push([method, payload]); return reply; });
  overrideSessionScope(FILESYSTEM_READ_SCOPE, "granted");
  expect(fileMetadata("/repo/new.ts", null)).toBe(null);
  await tick();
  clock += 59_000;
  expect(fileMetadata("/repo/new.ts", null)).toBe(null);
  await tick();
  expect(asked).toHaveLength(1);
  reply = { entries: [{ kind: "file", byteLength: 3 }] };
  clock += 2_000;
  expect(fileMetadata("/repo/new.ts", null)).toBe(null);
  await tick();
  expect(asked).toHaveLength(2);
  expect(fileMetadata("/repo/new.ts", null)).toEqual({ kind: "file", byteLength: 3 });
  setRequestBackendForTest(null);
  overrideSessionScope(FILESYSTEM_READ_SCOPE, null);
  resetFileMetadataForTest();
});

test("changed checkpoints name the files of new, changed and removed checkpoints", () => {
  const same = [{ path: "keep.ts" }];
  const before = [{ id: "a", status: "ready", files: same }, { id: "b", status: "ready", files: [{ path: "old.ts" }] }, { id: "c", files: [{ path: "gone.ts" }] }];
  const after = [{ id: "a", status: "ready", files: same }, { id: "b", status: "ready", files: [{ path: "new.ts" }] }, { id: "d", files: [{ path: "/abs/x.ts" }] }];
  expect(changedCheckpointPaths(before, after, "/repo/").sort()).toEqual(["/abs/x.ts", "/repo/gone.ts", "/repo/new.ts", "/repo/old.ts"]);
});

test("a written file's metadata is asked again, under the sent path and the resolved one", async () => {
  resetFileMetadataForTest();
  const asked: unknown[] = [];
  setRequestBackendForTest(async (method, payload) => { asked.push([method, payload]); return { entries: [{ kind: "file", byteLength: 1 }] }; });
  overrideSessionScope(FILESYSTEM_READ_SCOPE, "granted");
  fileMetadata("/repo/a.txt", null);
  await tick();
  expect(asked).toHaveLength(1);
  invalidateWrittenFile("/repo", "a.txt", "a.txt");
  expect(fileMetadata("/repo/a.txt", null)).toBe(null);
  await tick();
  expect(asked).toHaveLength(2);
  setRequestBackendForTest(null);
  overrideSessionScope(FILESYSTEM_READ_SCOPE, null);
  resetFileMetadataForTest();
});
