import { expect, test } from "nsh/test";
import { fetchThreadLinkMetadata, readThreadLinkMetadata, resetThreadLinkLookupsForTest, threadLinkLookup } from "./threadLinkMetadata";

const waitFor = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5)); };

test("a server with threadLinkMetadata answers getThreadLinkMetadata with title and project", async () => {
  const calls: string[] = [];
  const request = async (method: string, payload: unknown) => {
    calls.push(method);
    if (method === "server.getConfig") return { threadLinkMetadata: true };
    expect(payload).toEqual({ threadIds: ["t1"] });
    return { t1: { title: "Archived work", projectId: "p1" } };
  };
  expect(await fetchThreadLinkMetadata(["t1"], request)).toEqual({ t1: { title: "Archived work", projectId: "p1" } });
  expect(calls).toEqual(["server.getConfig", "orchestration.getThreadLinkMetadata"]);
});

test("an older server falls back to getThreadTitles with no project", async () => {
  const calls: string[] = [];
  const request = async (method: string) => { calls.push(method); return method === "server.getConfig" ? {} : { t1: "Old title" }; };
  expect(await fetchThreadLinkMetadata(["t1"], request)).toEqual({ t1: { title: "Old title", projectId: null } });
  expect(calls).toEqual(["server.getConfig", "orchestration.getThreadTitles"]);
});

test("deleted ids are absent, malformed entries are dropped", () => {
  expect(readThreadLinkMetadata({ a: { title: "A", projectId: null }, b: 3 }, false)).toEqual({ a: { title: "A", projectId: null } });
});

test("the lookup is pending, then found or missing, and asks once per id", async () => {
  resetThreadLinkLookupsForTest();
  let asks = 0;
  const request = async (method: string) => { if (method !== "server.getConfig") asks += 1; return method === "server.getConfig" ? { threadLinkMetadata: true } : { t1: { title: "T", projectId: null } }; };
  expect(threadLinkLookup("t1", request).state).toBe("pending");
  expect(threadLinkLookup("t1", request).state).toBe("pending");
  await waitFor(() => threadLinkLookup("t1", request).state !== "pending");
  expect(threadLinkLookup("t1", request)).toEqual({ state: "found", metadata: { title: "T", projectId: null } });
  threadLinkLookup("t2", request);
  await waitFor(() => threadLinkLookup("t2", request).state !== "pending");
  expect(threadLinkLookup("t2", request).state).toBe("missing");
  expect(asks).toBe(2);
});
