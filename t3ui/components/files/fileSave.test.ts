import { expect, test } from "nsh/test";
import { createFileSaveSessions, FileSaveCoordinator, type FileSaveSessionDeps } from "./fileSave";
import { createRuntimeSaveSessions, fileSaveSessions, noteUnsavedEdit, setFileSaveWriter, setFilesystemAccessForTest, unsavedDraft } from "./fileSaveRuntime";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await wait(10);
}

test("edits are written once after the pause, newest contents last", async () => {
  const written: string[] = [];
  const pending: boolean[] = [];
  const coordinator = new FileSaveCoordinator({
    debounceMs: 30,
    persist: async (contents) => { written.push(contents); return true; },
    onPendingChange: (value) => pending.push(value),
    onConfirmed: () => true,
  });
  coordinator.change("a");
  coordinator.change("ab");
  coordinator.change("abc");
  expect(written).toEqual([]);
  await until(() => written.length > 0 && pending[pending.length - 1] === false);
  expect(written).toEqual(["abc"]);
  expect(pending[0]).toBe(true);
  expect(pending[pending.length - 1]).toBe(false);
  expect(coordinator.unconfirmedContents).toBe(null);
});

test("an edit made while a write is in flight is written behind it, in order", async () => {
  const written: string[] = [];
  let release: () => void = () => {};
  const coordinator = new FileSaveCoordinator({
    debounceMs: 5,
    persist: (contents) => new Promise<boolean>((resolve) => { written.push(contents); release = () => resolve(true); }),
    onPendingChange: () => {},
    onConfirmed: () => true,
  });
  coordinator.change("one");
  await until(() => written.length === 1);
  coordinator.change("two");
  release();
  await until(() => written.length === 2);
  release();
  expect(written).toEqual(["one", "two"]);
});

test("a failed write leaves the draft unconfirmed and pending", async () => {
  const pending: boolean[] = [];
  let tries = 0;
  const coordinator = new FileSaveCoordinator({
    debounceMs: 5,
    persist: async () => { tries += 1; return false; },
    onPendingChange: (value) => pending.push(value),
    onConfirmed: () => true,
  });
  coordinator.change("x");
  await until(() => tries === 1);
  await wait(30);
  expect(coordinator.unconfirmedContents).toBe("x");
  expect(pending).toEqual([true]);
});

function sessionDeps(overrides: Partial<FileSaveSessionDeps> & { written: string[] }): FileSaveSessionDeps {
  const unsaved = new Map<string, string>();
  return {
    debounceMs: 5,
    canPersist: () => true,
    subscribeWritable: () => () => {},
    persist: async (_target, contents) => { overrides.written.push(contents); return true; },
    confirm: () => true,
    readUnsaved: (target) => unsaved.get(target.relativePath) ?? null,
    ...overrides,
  };
}

test("releasing the last surface flushes the draft at once, and edits for a file nobody holds are dropped", async () => {
  const written: string[] = [];
  const sessions = createFileSaveSessions(sessionDeps({ written, debounceMs: 10_000 }));
  const target = { cwd: "/p", relativePath: "a.txt" };
  sessions.change(target, "ignored");
  const release = sessions.acquire(target, () => {});
  sessions.change(target, "draft");
  expect(written).toEqual([]);
  release();
  await until(() => written.length === 1);
  expect(written).toEqual(["draft"]);
});

test("a session that cannot write keeps the draft and writes it when write access returns", async () => {
  const written: string[] = [];
  const pending: [string, boolean][] = [];
  let writable = false;
  let regained: () => void = () => {};
  const sessions = createFileSaveSessions(sessionDeps({
    written,
    canPersist: () => writable,
    subscribeWritable: (_target, onWritable) => { regained = onWritable; return () => {}; },
    readUnsaved: () => "kept edit",
  }));
  sessions.acquire({ cwd: "/p", relativePath: "b.txt" }, (path, value) => pending.push([path, value]));
  await wait(30);
  expect(written).toEqual([]);
  writable = true;
  regained();
  await until(() => written.length === 1);
  expect(written).toEqual(["kept edit"]);
  expect(pending[0]).toEqual(["b.txt", true]);
});

test("the shared sessions write through projects.writeFile with the cwd and relative path, only with write access", async () => {
  const calls: { method: string; payload: unknown }[] = [];
  const sessions = createRuntimeSaveSessions(async (method, payload) => { calls.push({ method, payload }); return {}; });
  const target = { cwd: "/work/app", relativePath: "src/main.ts" };
  setFilesystemAccessForTest("readonly");
  const release = sessions.acquire(target, () => {});
  sessions.change(target, "no access");
  await wait(40);
  expect(calls).toEqual([]);
  setFilesystemAccessForTest("writable");
  sessions.change(target, "export {}\n");
  await until(() => calls.length === 1);
  expect(calls).toEqual([{ method: "projects.writeFile", payload: { cwd: "/work/app", relativePath: "src/main.ts", contents: "export {}\n" } }]);
  release();
  setFilesystemAccessForTest("unknown");
});

test("every surface reads the same unsaved draft until the write is confirmed", async () => {
  const writes: string[] = [];
  let fail = true;
  setFileSaveWriter(async (_method, payload) => { if (fail) throw new Error("offline"); writes.push((payload as { contents: string }).contents); return {}; });
  setFilesystemAccessForTest("writable");
  const target = { cwd: "/drafts", relativePath: "a.md" };
  const releaseA = fileSaveSessions.acquire(target, () => {});
  const releaseB = fileSaveSessions.acquire(target, () => {});
  expect(unsavedDraft(target)).toBe(null);
  noteUnsavedEdit(target, "from A");
  noteUnsavedEdit(target, "from B");
  // The failed write keeps the draft, so a reopened surface shows it over the file's read.
  await wait(700);
  expect(unsavedDraft(target)).toBe("from B");
  fail = false;
  noteUnsavedEdit(target, "from B, again");
  await until(() => writes.length === 1);
  expect(writes).toEqual(["from B, again"]);
  await until(() => unsavedDraft(target) === null);
  releaseA();
  releaseB();
  setFileSaveWriter(null);
  setFilesystemAccessForTest("unknown");
});
