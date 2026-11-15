// Load bounds for a large shell (an agent-history import lands ~150-500 threads): every shell stream event goes through the
// store's real ingestion path, and an event about one thread must not rebuild every other thread or re-run every reader.
import { expect, test } from "nsh/test";
import { effect } from "nsh";
import { allProjects, allThreads, applyShellEventForTest, applyThreadEventForTest, openThread, threadActivity, threadMessagesFor } from "./store";
import { BackendClient, type SocketConnection } from "./backend/client";

const THREADS = 300;
const PROJECTS = 10;
const project = (index: number) => ({ id: `project-${index}`, title: `p${index}`, workspaceRoot: `/work/p${index}`,
  createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" });
const shell = (index: number, over: Record<string, unknown> = {}) => ({
  id: `thread-${index}`, projectId: `project-${index % PROJECTS}`, title: `Imported ${index}`, status: "idle",
  createdAt: "2026-11-01T00:00:00Z", updatedAt: `2026-11-01T00:${String(index % 60).padStart(2, "0")}:00Z`, ...over,
});

function seed() {
  applyShellEventForTest({ kind: "snapshot", snapshot: {
    projects: Array.from({ length: PROJECTS }, (_, index) => project(index)),
    threads: Array.from({ length: THREADS }, (_, index) => shell(index)),
  } });
}

test("a thread.updated for one thread keeps every other thread and project object", () => {
  seed();
  const before = new Map(allProjects().flatMap((item) => item.threads).map((thread) => [thread.id, thread] as const));
  const projectsBefore = new Map(allProjects().map((item) => [item.id, item] as const));
  applyShellEventForTest({ kind: "thread.updated", location: "active", thread: shell(7, { title: "Renamed" }) });
  const after = allProjects().flatMap((item) => item.threads);
  const changed = after.filter((thread) => before.get(thread.id) !== thread).map((thread) => thread.id);
  expect(changed).toEqual(["thread-7"]);
  const changedProjects = allProjects().filter((item) => projectsBefore.get(item.id) !== item).map((item) => item.id);
  expect(changedProjects).toEqual(["project-7"]);
  expect(allProjects().flatMap((item) => item.threads).find((thread) => thread.id === "thread-7")?.title).toBe("Renamed");
});

test("an unchanged re-delivery of a thread does not notify readers", () => {
  seed();
  let runs = 0;
  let live = true;
  effect(() => { allProjects(); if (live) runs += 1; });
  const start = runs;
  for (let index = 0; index < THREADS; index++) applyShellEventForTest({ kind: "thread.updated", location: "active", thread: shell(index) });
  const extra = runs - start;
  live = false;
  expect(extra).toBe(0);
});

test("shell snapshots publish project and thread changes as one coherent update", () => {
  applyShellEventForTest({ kind: "snapshot", snapshot: { projects: [{ id: "old", title: "Old" }], threads: [{ ...shell(0), projectId: "old" }] } });
  const seen: string[][] = [];
  let live = true;
  effect(() => { const ids = allThreads().map((thread) => thread.id); if (live) seen.push(ids); });
  applyShellEventForTest({ kind: "snapshot", snapshot: { projects: [{ id: "new", title: "New" }], threads: [{ ...shell(0), projectId: "new" }] } });
  live = false;
  expect(seen.every((ids) => ids.length === 1 && ids[0] === "thread-0")).toBe(true);
});

test("300 thread.updated events over 300 threads stay fast", () => {
  seed();
  const started = Date.now();
  for (let index = 0; index < THREADS; index++) {
    applyShellEventForTest({ kind: "thread.updated", location: "active", thread: shell(index, { title: `T${index}` }) });
  }
  const perEvent = (Date.now() - started) / THREADS;
  console.log(`shellLoad: ${perEvent.toFixed(2)} ms per thread.updated with ${THREADS} threads`);
  expect(perEvent < 5).toBe(true);
});

// A long imported thread opened from the sidebar: its subscribeThread snapshot carries thousands of turn items.
const ITEMS = 4000;
const turnItem = (index: number) => ({
  id: `item-${index}`, type: index % 2 === 0 ? "user_message" : "assistant_message", messageId: `message-${index}`,
  text: `text ${index}`, startedAt: "2026-11-01T00:00:00Z", status: "completed",
});

test("a 4000-item thread snapshot folds in linear time with every message kept once", () => {
  seed();
  const open = openThread();
  expect(open?.id).toBe("thread-0");
  const rows = Array.from({ length: ITEMS }, (_, index) => ({ item: turnItem(index) }));
  rows.push({ item: { ...turnItem(5), text: "edited" } });
  const started = Date.now();
  applyThreadEventForTest("thread-0", { kind: "snapshot", projection: { messages: [], runs: [], visibleTurnItems: rows } });
  const elapsed = Date.now() - started;
  console.log(`shellLoad: ${elapsed} ms for a ${ITEMS}-item thread snapshot`);
  const messages = threadMessagesFor("thread-0");
  expect(messages.length).toBe(ITEMS);
  expect(messages[5].body).toBe("edited");
  expect(elapsed < 500).toBe(true);
});

test("a streamed tool update preserves activity for unchanged turn items", () => {
  seed();
  const tool = (index: number, output = "done") => ({ id: `tool-${index}`, type: "dynamic_tool", toolName: "read", input: { path: `file-${index}` }, output, status: "completed" });
  applyThreadEventForTest("thread-0", { kind: "snapshot", snapshotSequence: 0, projection: { messages: [], runs: [], visibleTurnItems: Array.from({ length: 2000 }, (_, index) => ({ item: tool(index) })) } });
  const before = threadActivity();
  const started = Date.now();
  applyThreadEventForTest("thread-0", { kind: "event", sequence: 1, event: { type: "turn-item.updated", payload: tool(1999, "updated") } });
  const after = threadActivity();
  console.log(`shellLoad: ${Date.now() - started} ms for a tool update in 2000 activity items`);
  expect(after.length).toBe(2000);
  expect(after[0] === before[0]).toBe(true);
  expect(after[1999] === before[1999]).toBe(false);
  expect(after[1999].detail).toContain("updated");
});

test("a request sent with timeoutMs Infinity is never timed out by the client", async () => {
  const writes: string[] = [];
  let release: (value: string | null) => void = () => {};
  const socket: SocketConnection = {
    read: () => new Promise((resolve) => { release = resolve; }),
    write: async (data) => { writes.push(String(data)); },
    close: async () => {},
  };
  const client = new BackendClient(() => {}, async () => socket, { now: () => 0, setInterval: () => 0, clearInterval: () => {} });
  await client.connect("ws://test.invalid");
  let settled = false;
  const answer = client.request("agentSessions.import", {}, { timeoutMs: Infinity }).then((value) => { settled = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(settled).toBe(false);
  const id = JSON.parse(writes[0]).id;
  release(JSON.stringify({ _tag: "Exit", requestId: id, exit: { _tag: "Success", value: { importedCount: 3 } } }));
  expect(await answer).toEqual({ importedCount: 3 });
  client.close();
});
