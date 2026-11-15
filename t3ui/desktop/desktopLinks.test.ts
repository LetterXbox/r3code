import { expect, test } from "nsh/test";
import { createWebLinkRouter, type WebLinkDeps } from "./webLinks";
import { parseNewThreadLink, promptLinkAppPath, readPairingAppLink, sanitizeLinkedPrompt } from "./promptLinkParse";
import { boundsToSave, parseSavedBounds, resolveInitialBounds, windowFitsWithinDisplay } from "./windowBounds";
import { createNativeNotifications } from "./nativeNotifications";

function fakeDeps(over: Partial<WebLinkDeps> = {}) {
  const log: string[] = [];
  const toasts: Array<{ title: string; description?: string; actions?: Array<{ label: string; run: () => void }> }> = [];
  let draft = "";
  let ready = true;
  const deps: WebLinkDeps = {
    ready: () => ready,
    reveal: () => log.push("reveal"),
    openThreadById: (id) => log.push(`open:${id}`),
    threadExists: (id) => id === "t1",
    newThread: (projectId) => log.push(`new:${projectId}`),
    projectFor: (repo) => (repo ? (repo.name === "known" ? "p-known" : null) : "p-active"),
    draft: () => draft,
    setDraft: (text) => { draft = text; log.push(`draft:${text}`); },
    hasOpenThread: () => true,
    threadShowingBrowser: () => false,
    startThread: async () => { log.push("scratch"); return true; },
    openUrl: (url) => log.push(`preview:${url}`),
    openFile: async (threadId, path) => { log.push(`file:${threadId}:${path}`); },
    openThreadId: () => "t1",
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
  return { deps, log, toasts, setReady: (v: boolean) => { ready = v; }, setDraftText: (v: string) => { draft = v; } };
}

test("promptLinkAppPath reads app scheme and hosted links", () => {
  expect(promptLinkAppPath("t3code://new?prompt=hi")).toBe("/new?prompt=hi");
  expect(promptLinkAppPath("t3code-dev://threads/env/t1?prompt=x")).toBe("/env/t1?prompt=x");
  expect(promptLinkAppPath("https://app.t3.codes/new?prompt=a")).toBe("/new?prompt=a");
  expect(promptLinkAppPath("https://example.com/new?prompt=a")).toBe(null);
  expect(readPairingAppLink("t3code://pair?pairingUrl=https%3A%2F%2Fh.example%2Fpair%23t")).toBe("https://h.example/pair#t");
});

test("linked prompts drop hidden characters and refuse only-hidden ones", () => {
  expect(sanitizeLinkedPrompt("a\u200Bb")).toEqual({ text: "ab", hiddenCharacters: 1 });
  const hidden = parseNewThreadLink("?prompt=%E2%80%8B");
  expect(hidden.ok).toBe(false);
  expect(parseNewThreadLink("?repo=x").ok).toBe(false);
  const ok = parseNewThreadLink("?prompt=fix&repo=o/known&provider=Codex");
  expect(ok.ok && ok.value.kind === "new" && ok.value.provider).toBe("codex");
});

test("a /new link starts a thread in the repo's project and places the prompt", async () => {
  const f = fakeDeps();
  const router = createWebLinkRouter(f.deps);
  router.receive(["t3code://new?prompt=hello&repo=o/known"]);
  await router.settled();
  expect(f.log).toEqual(["reveal", "new:p-known", "draft:hello"]);
  expect(f.toasts[0]?.title).toBe("Prompt added from a link");
});

test("a draft already there asks before it is replaced", async () => {
  const f = fakeDeps();
  f.setDraftText("mine");
  const router = createWebLinkRouter(f.deps);
  router.receive(["t3code://threads/env/t1?prompt=theirs"]);
  await router.settled();
  expect(f.log).toEqual(["reveal", "open:t1"]);
  expect(f.toasts[0]?.title).toBe("Linked prompt ready");
  f.toasts[0]?.actions?.[0]?.run();
  expect(f.log.at(-1)).toBe("draft:theirs");
});

test("links wait until the backend is ready, then run in order", async () => {
  const f = fakeDeps();
  f.setReady(false);
  const router = createWebLinkRouter(f.deps);
  router.receive(["https://example.com/a", "file:///tmp/page.html", "file:///tmp/notes.txt", "mailto:x@y"]);
  await router.settled();
  expect(f.log).toEqual([]);
  f.setReady(true);
  router.flush();
  await router.settled();
  expect(f.log).toEqual(["reveal", "scratch", "preview:https://example.com/a", "scratch", "file:t1:/tmp/page.html"]);
});

test("a pairing link confirms the host, pairs once", async () => {
  const f = fakeDeps();
  const router = createWebLinkRouter(f.deps);
  const link = "t3code://pair?pairingUrl=https%3A%2F%2Fh.example%2Fpair%23tok";
  router.receive([link]);
  await router.settled();
  router.receive([link]);
  await router.settled();
  expect(f.log.filter((l) => l.startsWith("pair:"))).toEqual(["pair:https://h.example/pair#tok"]);
  expect(f.toasts[0]?.title).toBe("Backend added");
});

test("an unknown thread or bad link reports the reference failure toast", async () => {
  const f = fakeDeps();
  const router = createWebLinkRouter(f.deps);
  router.receive(["t3code://threads/env/missing", "t3code://new?prompt=" + "x".repeat(8001)]);
  await router.settled();
  expect(f.toasts.map((t) => t.title)).toEqual(["Could not open the link", "Could not open the link"]);
  expect(f.toasts[1]?.description).toBe("This prompt is longer than 8,000 characters, so T3 Code did not open it.");
});

test("window bounds restore only when a screen holds them", () => {
  const screen = { x: 0, y: 25, width: 1512, height: 920 };
  const saved = parseSavedBounds(JSON.stringify({ x: 10, y: 30, width: 900, height: 700, maximized: false }));
  expect(resolveInitialBounds(saved, [screen])).toEqual(saved);
  expect(resolveInitialBounds({ ...saved!, x: 2000 }, [screen])).toBe(null);
  expect(windowFitsWithinDisplay({ x: -1, y: 24, width: 1514, height: 922 }, screen)).toBe(true);
  expect(parseSavedBounds(JSON.stringify({ x: 0, y: 0, width: 300, height: 700 }))).toBe(null);
  expect(parseSavedBounds("nope")).toBe(null);
});

test("frames save normal bounds, keep them while zoomed, skip full screen", () => {
  const frame = { x: 10.4, y: 30, width: 900, height: 700, maximized: false, fullScreen: false, screens: [] };
  const normal = boundsToSave(frame, null);
  expect(normal).toEqual({ x: 10, y: 30, width: 900, height: 700, maximized: false });
  expect(boundsToSave({ ...frame, maximized: true, width: 1512 }, normal)).toEqual({ ...normal!, maximized: true });
  expect(boundsToSave({ ...frame, fullScreen: true }, normal)).toBe(null);
});

test("native notifications badge the Dock and a click opens the thread", async () => {
  const log: string[] = [];
  const n = createNativeNotifications({
    post: async (input) => { log.push(`post:${input.id}`); return true; },
    badge: (count) => log.push(`badge:${count}`),
    open: (id) => log.push(`open:${id}`),
    reveal: () => log.push("reveal"),
  });
  expect(await n.notify("t1", "Done", "Thread one")).toBe(true);
  expect(await n.notify("t2", "Done", "Thread two")).toBe(true);
  expect(n.clicked("thread-notification:t1:1")).toBe(true);
  expect(log).toEqual(["post:thread-notification:t1:1", "badge:1", "post:thread-notification:t2:2", "badge:2", "badge:1", "reveal", "open:t1"]);
  n.clear();
  expect(log.at(-1)).toBe("badge:0");
  const none = createNativeNotifications({ post: async () => false, badge: () => log.push("never"), open: () => {}, reveal: () => {} });
  expect(await none.notify("t3", "a", "b")).toBe(false);
  expect(log.includes("never")).toBe(false);
});

test("provider sign-in returns and pull request links go into the app", async () => {
  const f = fakeDeps();
  const router = createWebLinkRouter(f.deps);
  router.receive(["t3code://app/settings/providers?instanceId=codex&secret=x#frag", "t3code://app/welcome#agents:codex", "https://github.com/o/r/pull/7"]);
  await router.settled();
  expect(f.log).toEqual(["reveal", "page:/settings/providers?instanceId=codex", "page:/welcome#agents:codex", "pr:https://github.com/o/r/pull/7"]);
});

const AUTH = "https://auth.openai.com/api/accounts/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&state=abcdefghijklmnop1234&response_type=code&code_challenge_method=S256&code_challenge=" + "a".repeat(43) + "&client_id=oaiapp_x";

test("a ChatGPT handoff goes to the launcher at once; its delivery completes and opens Settings", async () => {
  const f = fakeDeps();
  f.setReady(false);
  const router = createWebLinkRouter(f.deps);
  const request = JSON.stringify({ authorizationUrl: AUTH, returnUrl: "t3code://app/settings/providers?instanceId=codex", environmentId: "env1", instanceId: "codex", flowId: "flow1" });
  router.receive([`t3code://auth/codex?request=${encodeURIComponent(request)}`]);
  await new Promise((r) => setTimeout(r, 0));
  expect(f.log).toEqual(["handoff:flow1"]);
  router.receive(["t3code://auth/codex?request=%7B%7D"]);
  f.setReady(true);
  const delivery = encodeURIComponent(JSON.stringify({ environmentId: "env1", instanceId: "codex", flowId: "flow1", callbackUrl: "http://127.0.0.1:1455/auth/callback?code=c&state=abcdefghijklmnop1234", returnHash: "" }));
  router.receive([`t3code://app/settings/providers?instanceId=codex#codex-auth=${delivery}`]);
  await router.settled();
  expect(f.log).toEqual(["handoff:flow1", "reveal", "page:/settings/providers?instanceId=codex", "complete:flow1:http://127.0.0.1:1455/auth/callback?code=c&state=abcdefghijklmnop1234"]);
});
