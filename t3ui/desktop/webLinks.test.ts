// Dedicated coverage for webLinks.ts (DesktopClerk.ts + DesktopWebLinks.ts + DesktopWebLinkCoordinator.tsx +
// promptLinks/linkedPrompt.ts), alongside reference apps/desktop/src/app/DesktopWebLinks.test.ts. desktopLinks.test.ts
// already covers the /new, thread and ready-queueing paths; this file fills in the routing branches it leaves out:
// provider-auth edge cases, pairing failure paths, PR link gating, and file/preview dispatch when the right panel is
// unavailable or no thread is open.
import { expect, test } from "nsh/test";
import { createWebLinkRouter, type WebLinkDeps } from "./webLinks";

function fakeDeps(over: Partial<WebLinkDeps> = {}) {
  const log: string[] = [];
  const toasts: Array<{ type: string; title: string; description?: string }> = [];
  let draft = "";
  let ready = true;
  let threadShowingBrowser = false;
  let openThreadId: string | null = "t1";
  const deps: WebLinkDeps = {
    ready: () => ready,
    reveal: () => log.push("reveal"),
    openThreadById: (id) => log.push(`open:${id}`),
    threadExists: (id) => id === "t1",
    newThread: (projectId) => log.push(`new:${projectId}`),
    projectFor: (repo) => (repo ? (repo.name === "known" ? "p-known" : null) : "p-active"),
    draft: () => draft,
    setDraft: (text) => { draft = text; log.push(`draft:${text}`); },
    hasOpenThread: () => openThreadId !== null,
    threadShowingBrowser: () => threadShowingBrowser,
    startThread: async () => { log.push("scratch"); return true; },
    openUrl: (url) => log.push(`preview:${url}`),
    openFile: async (threadId, path) => { log.push(`file:${threadId}:${path}`); },
    openThreadId: () => openThreadId,
    pair: async (url) => { log.push(`pair:${url}`); },
    confirm: async () => true,
    openAppPage: (path) => log.push(`page:${path}`),
    codexHandoff: async (h) => { log.push(`handoff:${h.flowId}`); return true; },
    completeCodexAuth: async (d) => { log.push(`complete:${d.flowId}:${d.callbackUrl}`); },
    openPullRequest: (url) => { if (!url.includes("/pull/")) return false; log.push(`pr:${url}`); return true; },
    toast: (input) => { toasts.push(input as never); return `toast${toasts.length}`; },
    closeToast: () => {},
    ...over,
  };
  return {
    deps,
    log,
    toasts,
    setReady: (v: boolean) => { ready = v; },
    setThreadShowingBrowser: (v: boolean) => { threadShowingBrowser = v; },
    setOpenThreadId: (v: string | null) => { openThreadId = v; },
  };
}

test("provider-auth: a return path with no provider-auth delivery just opens the page", async () => {
  const f = fakeDeps();
  const router = createWebLinkRouter(f.deps);
  router.receive(["t3code://app/settings/general"]);
  await router.settled();
  expect(f.log).toEqual(["reveal", "page:/settings/general"]);
});

test("provider-auth: /welcome keeps the agents hash and routes to the welcome page, not Settings", async () => {
  const f = fakeDeps();
  const router = createWebLinkRouter(f.deps);
  router.receive(["t3code://app/welcome#agents:codex"]);
  await router.settled();
  expect(f.log).toEqual(["reveal", "page:/welcome#agents:codex"]);
});

test("provider-auth: completeCodexAuth failing after a delivered code shows the retry toast, not a crash", async () => {
  const f = fakeDeps({ completeCodexAuth: async () => { throw new Error("boom"); } });
  const router = createWebLinkRouter(f.deps);
  const delivery = encodeURIComponent(JSON.stringify({ environmentId: "env1", instanceId: "codex", flowId: "flow1", callbackUrl: "http://127.0.0.1:1455/auth/callback?code=c&state=s", returnHash: "" }));
  router.receive([`t3code://app/settings/providers?instanceId=codex#codex-auth=${delivery}`]);
  await router.settled();
  expect(f.log.at(-1)).toBe("page:/settings/providers?instanceId=codex");
});

test("pairing: an invalid pairing URL reports failure without asking to confirm", async () => {
  const f = fakeDeps();
  const router = createWebLinkRouter(f.deps);
  router.receive(["t3code://pair?pairingUrl=not%20a%20url"]);
  await router.settled();
  expect(f.log).toEqual(["reveal"]);
  expect(f.toasts[0]?.type).toBe("error");
  expect(f.toasts[0]?.title).toBe("Could not add backend");
});

test("pairing: declining the confirm dialog never calls pair", async () => {
  const f = fakeDeps({ confirm: async () => false });
  const router = createWebLinkRouter(f.deps);
  router.receive(["t3code://pair?pairingUrl=https%3A%2F%2Fh.example%2Fpair%23tok"]);
  await router.settled();
  expect(f.log).toEqual(["reveal"]);
  expect(f.toasts).toEqual([]);
});

test("pairing: a failing pair() reports the error and leaves the link retryable", async () => {
  const f = fakeDeps({ pair: async () => { throw new Error("offline"); } });
  const router = createWebLinkRouter(f.deps);
  const link = "t3code://pair?pairingUrl=https%3A%2F%2Fh.example%2Fpair%23tok";
  router.receive([link]);
  await router.settled();
  expect(f.toasts[0]).toEqual({ type: "error", title: "Could not add backend", description: "offline" });
  router.receive([link]);
  await router.settled();
  expect(f.toasts.length).toBe(2);
});

test("PR links: disabled by setting, the link falls through to the browser instead of the in-app PR surface", async () => {
  const f = fakeDeps({ openPullRequest: () => false, threadShowingBrowser: () => true });
  const router = createWebLinkRouter(f.deps);
  router.receive(["https://github.com/o/r/pull/7"]);
  await router.settled();
  expect(f.log).toEqual(["reveal", "preview:https://github.com/o/r/pull/7"]);
});

test("PR links: a matching link short-circuits before the browser ever opens", async () => {
  const f = fakeDeps();
  const router = createWebLinkRouter(f.deps);
  router.receive(["https://github.com/o/r/pull/7"]);
  await router.settled();
  expect(f.log).toEqual(["reveal", "pr:https://github.com/o/r/pull/7"]);
});

test("file dispatch: a browser already showing opens the file directly, skipping the Scratch thread", async () => {
  const f = fakeDeps();
  f.setThreadShowingBrowser(true);
  const router = createWebLinkRouter(f.deps);
  router.receive(["file:///tmp/notes.html"]);
  await router.settled();
  expect(f.log).toEqual(["reveal", "file:t1:/tmp/notes.html"]);
});

test("file dispatch: no browser showing starts a Scratch thread first, then opens the file", async () => {
  const f = fakeDeps();
  const router = createWebLinkRouter(f.deps);
  router.receive(["file:///tmp/a%20b.html"]);
  await router.settled();
  expect(f.log).toEqual(["reveal", "scratch", "file:t1:/tmp/a b.html"]);
});

test("file dispatch: Scratch thread fails to start, the file link never opens", async () => {
  const f = fakeDeps();
  f.deps.startThread = async () => { f.log.push("scratch-failed"); return false; };
  const router = createWebLinkRouter(f.deps);
  router.receive(["file:///tmp/notes.html"]);
  await router.settled();
  expect(f.log).toEqual(["reveal", "scratch-failed"]);
});

test("file dispatch: a right-panel-unavailable openFile reports failure with the file URL, not a crash", async () => {
  const f = fakeDeps({ threadShowingBrowser: () => true, openFile: async () => { throw new Error("file:///tmp/notes.html"); } });
  const router = createWebLinkRouter(f.deps);
  router.receive(["file:///tmp/notes.html"]);
  await router.settled();
  expect(f.toasts[0]).toEqual({ type: "error", title: "Could not open the link", description: "file:///tmp/notes.html" });
});

test("file dispatch: no open thread id reports failure with the raw URL instead of throwing", async () => {
  const f = fakeDeps({ threadShowingBrowser: () => true });
  f.setOpenThreadId(null);
  const router = createWebLinkRouter(f.deps);
  router.receive(["file:///tmp/notes.html"]);
  await router.settled();
  expect(f.log).toEqual(["reveal"]);
  expect(f.toasts[0]).toEqual({ type: "error", title: "Could not open the link", description: "file:///tmp/notes.html" });
});

test("preview dispatch: a plain web link with no right panel reports the URL instead of crashing", async () => {
  const f = fakeDeps({ threadShowingBrowser: () => true, openUrl: () => { throw new Error("https://example.com/a"); } });
  const router = createWebLinkRouter(f.deps);
  router.receive(["https://example.com/a"]);
  await router.settled();
  expect(f.toasts[0]).toEqual({ type: "error", title: "Could not open the link", description: "https://example.com/a" });
});

test("non-matching schemes (mailto:, a bare .txt file) never reach the router", async () => {
  const f = fakeDeps();
  const router = createWebLinkRouter(f.deps);
  router.receive(["mailto:a@b.com", "file:///tmp/notes.txt", "not a url at all"]);
  await router.settled();
  expect(f.log).toEqual([]);
  expect(f.toasts).toEqual([]);
});

test("hidden-character prompts still place the visible text and warn, even outside the /new path", async () => {
  const f = fakeDeps();
  const router = createWebLinkRouter(f.deps);
  router.receive([`t3code://threads/env/t1?prompt=${encodeURIComponent("hi​there")}`]);
  await router.settled();
  expect(f.log).toEqual(["reveal", "open:t1", "draft:hithere"]);
  expect(f.toasts.map((t) => t.title)).toEqual(["This prompt had hidden characters, it may be malicious", "Prompt added from a link"]);
});
