import { expect, test } from "nsh/test";
import { confirmOrphanedWorktree, sideChatsOfDeletedThread } from "./threadFamilyDelete";

const server = (families: boolean, answers: Record<string, unknown>) => {
  const calls: { method: string; payload: unknown }[] = [];
  const request = async (method: string, payload: unknown) => {
    calls.push({ method, payload });
    if (method === "server.getConfig") return families ? { shellThreadFamilies: true } : {};
    const answer = answers[method];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, request };
};

test("without shellThreadFamilies the local answer stands and the server is not asked", async () => {
  const s = server(false, {});
  expect(await confirmOrphanedWorktree("/w/a", "t1", undefined, s.request)).toBe("/w/a");
  expect(s.calls.map((c) => c.method)).toEqual(["server.getConfig"]);
});

test("getWorktreeThreadIds decides: another occupant keeps the worktree, deleted ones do not", async () => {
  const other = server(true, { "orchestration.getWorktreeThreadIds": { threadIds: ["t1", "t2"] } });
  expect(await confirmOrphanedWorktree("/w/a", "t1", undefined, other.request)).toBe(null);
  expect(other.calls[1]).toEqual({ method: "orchestration.getWorktreeThreadIds", payload: { worktreePath: "/w/a" } });
  const deleted = server(true, { "orchestration.getWorktreeThreadIds": { threadIds: ["t1", "t2"] } });
  expect(await confirmOrphanedWorktree("/w/a", "t1", new Set(["t2"]), deleted.request)).toBe("/w/a");
  const failed = server(true, { "orchestration.getWorktreeThreadIds": new Error("boom") });
  expect(await confirmOrphanedWorktree("/w/a", "t1", undefined, failed.request)).toBe(null);
});

test("side chats of an unlisted thread come from getThreadFamily when the shell can omit them", async () => {
  const s = server(true, { "orchestration.getThreadFamily": { snapshotSequence: 3, threads: [
    { id: "t1", lineage: { parentThreadId: null, sideChat: false } },
    { id: "s1", lineage: { parentThreadId: "t1", sideChat: true } },
    { id: "k1", lineage: { parentThreadId: "t1", sideChat: false } },
  ] } });
  expect(await sideChatsOfDeletedThread("t1", [], s.request)).toEqual(["s1"]);
  expect(s.calls[1]).toEqual({ method: "orchestration.getThreadFamily", payload: { threadId: "t1" } });
  const local = server(false, {});
  expect(await sideChatsOfDeletedThread("t1", [{ id: "s2", sideChat: true, parentThreadId: "t1" }], local.request)).toEqual(["s2"]);
});
