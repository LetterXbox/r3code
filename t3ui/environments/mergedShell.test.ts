import { expect, test } from "nsh/test";
import type { SocketConnection } from "../backend/client";
import { allProjects, allThreads, applyShellEventForTest, archivedThreads, isServerThread, refreshArchivedThreads, refreshMergedShell, requestBackend, setRequestBackendForTest } from "../store";
import { savedEnvironmentStatus } from "../pages/settings/environments/savedEnvironments";
import { projectEnvironmentDescription } from "./EnvironmentBadges";
import { readThreadAttachment } from "../components/thread/readAttachment";
import { refreshRemoteArchive, remoteShell, resetEnvironmentsForTest, setEnvironmentTransportForTest, syncEnvironments } from "./connectionManager";

class FakeSocket implements SocketConnection {
  sent: string[] = [];
  private incoming: (string | null)[] = [];
  private reader: ((value: string | null) => void) | null = null;
  async write(data: string | Uint8Array) { this.sent.push(typeof data === "string" ? data : new TextDecoder().decode(data)); }
  read(): Promise<string | Uint8Array | null> {
    if (this.incoming.length) return Promise.resolve(this.incoming.shift() ?? null);
    return new Promise((resolve) => { this.reader = resolve; });
  }
  async close() { this.push(null); }
  push(value: string | null) { const r = this.reader; this.reader = null; if (r) r(value); else this.incoming.push(value); }
  frame(value: unknown) { this.push(JSON.stringify(value)); }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

const thread = (id: string, projectId: string) => ({ id, projectId, title: id, status: "idle", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });

test("a saved environment's shell merges into the store with scoped ids, and its commands route to it", async () => {
  applyShellEventForTest({ kind: "snapshot", snapshot: { projects: [{ id: "p", title: "Primary" }], threads: [thread("a", "p")] } });
  const primaryProjects = allProjects();
  refreshMergedShell();
  // No saved environment: the primary lists are untouched.
  expect(allProjects() === primaryProjects).toBe(true);

  const socket = new FakeSocket();
  setEnvironmentTransportForTest({ ticket: async (url) => url, open: async () => socket });
  syncEnvironments([{ id: "saved:box", label: "box", url: "ws://box/ws", enabled: true }]);
  await until(() => socket.sent.some((text) => text.includes("subscribeServerConfig")));
  // rpc/session.ts: the config stream comes first (with the runtime flags); the shell follows its snapshot.
  expect(JSON.parse(socket.sent.find((text) => text.includes("subscribeServerConfig"))!).payload).toEqual({ environmentThemes: true, usageLimitSources: true, usageLimitsCommand: true, workspaceSnapshotsOnDemand: true });
  socket.frame({ _tag: "Chunk", requestId: "1", values: [{ type: "snapshot", config: { environment: { label: "box", serverVersion: "1" } } }] });
  await until(() => socket.sent.some((text) => text.includes("orchestration.subscribeShell")));
  socket.frame({ _tag: "Chunk", requestId: "2", values: [{ kind: "snapshot", snapshot: { projects: [{ id: "p", title: "Remote" }], threads: [{ ...thread("a", "p"), lineage: { parentThreadId: "parent", rootThreadId: "root", relationshipToParent: "subagent" }, forkedFrom: { type: "run", threadId: "fork-source" }, delegatedFrom: { environmentId: "other", threadId: "other-thread", title: "Other" } }] } }] });
  await until(() => remoteShell("saved:box")?.loaded === true);
  refreshMergedShell();

  const remote = allProjects().find((project) => project.id === "saved:box:p");
  expect(remote?.environmentId).toBe("saved:box");
  expect(remote?.threads[0]?.id).toBe("saved:box:a");
  expect(remote?.threads[0]?.relations?.lineage?.parentThreadId).toBe("saved:box:parent");
  expect(remote?.threads[0]?.relations?.lineage?.rootThreadId).toBe("saved:box:root");
  expect(remote?.threads[0]?.relations?.forkSourceThreadId).toBe("saved:box:fork-source");
  expect(remote?.threads[0]?.relations?.delegatedFrom?.threadId).toBe("other-thread");
  expect(allProjects().some((project) => project.id === "p")).toBe(true);
  expect(allThreads().filter((item) => item.environmentId === "saved:box").length).toBe(1);
  expect(isServerThread("saved:box:a")).toBe(true);
  expect(projectEnvironmentDescription(remote?.environmentId)).toBe("On box");
  expect(savedEnvironmentStatus({ id: "saved:box", label: "box", url: "ws://box/ws", enabled: true, addedAt: 0 }, undefined).text).toBe("Connected");

  const titles = requestBackend("orchestration.getThreadTitles", { threadIds: ["saved:box:parent"] });
  await until(() => socket.sent.some((text) => text.includes("orchestration.getThreadTitles")));
  const titlesRequest = JSON.parse(socket.sent.find((text) => text.includes("orchestration.getThreadTitles"))!);
  expect(titlesRequest.payload.threadIds).toEqual(["parent"]);
  socket.frame({ _tag: "Exit", requestId: String(titlesRequest.id), exit: { _tag: "Success", value: { parent: "Parent title" } } });
  expect(await titles).toEqual({ parent: "Parent title" });

  const originalFetch = globalThis.fetch;
  const fetched: string[] = [];
  try {
    globalThis.fetch = async (input) => { fetched.push(String(input)); return new Response("remote image", { status: 200 }); };
    const reading = readThreadAttachment("saved:box:a", "remote-asset", { signal: new AbortController().signal, maxBytes: 100 });
    await until(() => socket.sent.some((text) => text.includes("assets.createUrl")));
    const assetRequest = JSON.parse(socket.sent.find((text) => text.includes("assets.createUrl"))!);
    expect(assetRequest.payload.resource.attachmentId).toBe("remote-asset");
    socket.frame({ _tag: "Exit", requestId: String(assetRequest.id), exit: { _tag: "Success", value: { relativeUrl: "/api/assets/signed/image", expiresAt: 1800000000000 } } });
    expect(await (await reading).text()).toBe("remote image");
    expect(fetched).toEqual(["http://box/api/assets/signed/image"]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const loadRemoteArchive = refreshRemoteArchive("saved:box");
  await until(() => socket.sent.some((text) => text.includes("getArchivedShellSnapshot")));
  const archiveRequest = JSON.parse(socket.sent.find((text) => text.includes("getArchivedShellSnapshot"))!);
  socket.frame({ _tag: "Chunk", requestId: "2", values: [{ kind: "thread.updated", location: "archive", thread: thread("new-remote", "p") }] });
  await until(() => remoteShell("saved:box")!.archived.some((item) => item.id === "new-remote"));
  socket.frame({ _tag: "Chunk", requestId: "2", values: [{ kind: "thread.updated", location: "active", thread: thread("restored", "p") }] });
  await until(() => remoteShell("saved:box")!.threads.some((item) => item.id === "restored"));
  socket.frame({ _tag: "Exit", requestId: String(archiveRequest.id), exit: { _tag: "Success", value: { threads: [thread("archived", "p"), thread("restored", "p")] } } });
  await loadRemoteArchive;
  expect(remoteShell("saved:box")!.archived.map((item) => item.id)).toEqual(["archived", "new-remote"]);
  refreshMergedShell();
  expect(archivedThreads().some((item) => item.id === "saved:box:archived")).toBe(true);
  setRequestBackendForTest(async () => ({ threads: [thread("primary-archived", "p")] }));
  await refreshArchivedThreads();
  setRequestBackendForTest(null);
  expect(archivedThreads().some((item) => item.id === "primary-archived")).toBe(true);
  expect(archivedThreads().some((item) => item.id === "saved:box:archived")).toBe(true);

  const reply = requestBackend("orchestration.dispatchCommand", { command: { type: "thread.archive", threadId: "saved:box:a" } });
  await until(() => socket.sent.some((text) => text.includes("dispatchCommand")));
  const sent = socket.sent.find((text) => text.includes("dispatchCommand")) ?? "";
  expect(sent.includes('"threadId":"a"')).toBe(true);
  socket.frame({ _tag: "Exit", requestId: String(JSON.parse([...socket.sent].reverse().find((text) => text.includes("dispatchCommand")) ?? "{}").id), exit: { _tag: "Success", value: { sequence: 1, threadId: "a", thread: { projectId: "p" } } } });
  const answer = await reply as { threadId: string; thread: { projectId: string } };
  // Ids in a remote answer come back scoped, so opening what it names works.
  expect(answer.threadId).toBe("saved:box:a");
  expect(answer.thread.projectId).toBe("saved:box:p");

  // clearComposerDraftsEnvironment: a draft in the remote project goes when its environment is removed.
  const { createThread, openThread, setComposerDraft, sidebarDrafts } = await import("../store");
  const { clearComposerDraftsEnvironment, hasDraftThreadsInEnvironment } = await import("./environmentDrafts");
  createThread("saved:box:p");
  setComposerDraft("remote draft");
  expect(openThread()?.projectId).toBe("saved:box:p");
  expect(hasDraftThreadsInEnvironment("saved:box")).toBe(true);
  clearComposerDraftsEnvironment("saved:box");
  expect(hasDraftThreadsInEnvironment("saved:box")).toBe(false);
  expect(sidebarDrafts().length).toBe(0);

  syncEnvironments([]);
  refreshMergedShell();
  expect(allProjects().some((project) => project.environmentId)).toBe(false);
  resetEnvironmentsForTest();
  setEnvironmentTransportForTest(null);
});
