import { expect, test } from "nsh/test";
import { signal } from "nsh";
import { watchServerPreviews } from "./serverPreviewSync";

// client-runtime preview.ts: `preview.list` is a query with a 5 s stale time. Workspace updates that keep the same open thread
// must not list it again (the live trace showed 13 lists for one thread in a minute).
test("the open thread is listed once per 5 s, not on every workspace update", async () => {
  const lists: string[] = [];
  const thread = signal<string | null>("t1");
  const tick = signal(0);
  watchServerPreviews({
    request: async (method, payload) => { lists.push(`${method}:${(payload as { threadId: string }).threadId}`); return { sessions: [], serverEpoch: "E", revision: 1 }; },
    subscribe: () => () => {},
    connected: () => true,
    threadId: () => { tick(); return thread(); },
  });
  tick.set(1);
  tick.set(2);
  expect(lists).toEqual(["preview.list:t1"]);
  thread.set("t2");
  expect(lists).toEqual(["preview.list:t1", "preview.list:t2"]);
});

test("staying on one thread never lists it again, however long workspace updates keep coming", async () => {
  const lists: string[] = [];
  const tick = signal(0);
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    watchServerPreviews({
      request: async (method) => { lists.push(method); return { sessions: [], serverEpoch: "E", revision: 1 }; },
      subscribe: () => () => {},
      connected: () => true,
      threadId: () => { tick(); return "t1"; },
    });
    now += 60_000;
    tick.set(1);
    expect(lists.length).toBe(1);
  } finally {
    Date.now = realNow;
  }
});
