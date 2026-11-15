// view.reopenClosed: tabs that leave the open thread's right panel come back newest first, and the shortcut is only bound while there is one.
import { expect, test } from "nsh/test";
import { closeActiveSurfaceAction, openFileAction, overridePanelContext, panelStateFor, updatePanel } from "../components/rightPanel/panelState";
import { clearClosedViews, closedViews, hasClosedViews, installClosedViews, isValidClosedView, planNextReopen, reopenClosedView, setReopenRequestForTest, threadIdOfPanelKey } from "./closedViews";
import { EMPTY_THREAD_PREVIEW, serverPreviews } from "../components/rightPanel/serverPreviewSessions";
import { recordTabViewport } from "../components/rightPanel/previewViewportMemory";
import { hasCommandHandler, runCommand } from "./registry";

const KEY = JSON.stringify(["ws://x", "thread:1"]);

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
}

test("planNextReopen drops what is open again and restores the first that is not", () => {
  const entry = (id: string) => ({ id, panelKey: KEY, surface: { id, kind: "file" as const, relativePath: id } });
  const plan = planNextReopen([entry("a"), entry("b"), entry("c")], (candidate) => candidate.id === "a");
  expect(plan.drop.map((item) => item.id)).toEqual(["a"]);
  expect(plan.restore?.id).toBe("b");
  expect(planNextReopen([entry("a")], () => true).restore).toBe(null);
});

test("the thread of a panel key is its second part", () => {
  expect(threadIdOfPanelKey(KEY)).toBe("thread:1");
  expect(threadIdOfPanelKey("not json")).toBe(null);
});

test("a closed file tab is remembered and view.reopenClosed brings it back", async () => {
  clearClosedViews();
  overridePanelContext({ key: KEY, workspace: { threadId: "thread:1", cwd: "/work" } });
  installClosedViews();
  expect(hasCommandHandler("view.reopenClosed")).toBe(true);
  // Nothing closed yet: the shortcut is not taken.
  expect(runCommand("view.reopenClosed")).toBe(false);
  openFileAction("src/app.ts", 7);
  openFileAction("README.md");
  expect(panelStateFor(KEY).surfaces.map((surface) => surface.id)).toEqual(["file:src/app.ts", "file:README.md"]);
  closeActiveSurfaceAction();
  await until(hasClosedViews);
  expect(closedViews().map((entry) => entry.surface.id)).toEqual(["file:README.md"]);
  expect(panelStateFor(KEY).surfaces.map((surface) => surface.id)).toEqual(["file:src/app.ts"]);
  expect(runCommand("view.reopenClosed")).toBe(true);
  expect(panelStateFor(KEY).surfaces.map((surface) => surface.id)).toEqual(["file:src/app.ts", "file:README.md"]);
  expect(panelStateFor(KEY).activeId).toBe("file:README.md");
  expect(hasClosedViews()).toBe(false);
  overridePanelContext(null);
});

test("a tab that is open again is dropped instead of restored twice", async () => {
  clearClosedViews();
  overridePanelContext({ key: KEY, workspace: { threadId: "thread:1", cwd: "/work" } });
  installClosedViews();
  openFileAction("a.ts");
  closeActiveSurfaceAction();
  await until(hasClosedViews);
  openFileAction("a.ts");
  expect(reopenClosedView()).toBe(false);
  expect(hasClosedViews()).toBe(false);
  expect(panelStateFor(KEY).surfaces.filter((surface) => surface.id === "file:a.ts")).toHaveLength(1);
  updatePanel(KEY, (state) => ({ ...state, surfaces: [], activeId: null }));
  overridePanelContext(null);
});

test("fm13: a closed tab whose thread is gone is skipped while connected and waits while not; saved entries need their kind's fields", async () => {
  const { isValidClosedView } = await import("./closedViews");
  const entry = (id: string) => ({ id, panelKey: "k", surface: { id: `s-${id}`, kind: "diff" } }) as never;
  const live = (ownerExists: boolean, shellLive = true) => ({ shellLive, ownerExists, sideChatExists: true, isOpen: false });
  expect(planNextReopen([entry("gone"), entry("ok")], (candidate: { id: string }) => live(candidate.id !== "gone")).restore?.id).toBe("ok");
  expect(planNextReopen([entry("gone"), entry("ok")], (candidate: { id: string }) => live(candidate.id !== "gone", false)).restore).toBeNull();
  expect(isValidClosedView({ id: "a", panelKey: "k", surface: { id: "file:x", kind: "file" } })).toBe(false);
  expect(isValidClosedView({ id: "a", panelKey: "k", surface: { id: "file:x", kind: "file", relativePath: "x" } })).toBe(true);
});

test("fm13: a closed browser tab keeps its device viewport and reopens with it", async () => {
  clearClosedViews();
  overridePanelContext({ key: KEY, workspace: { threadId: "thread:1", cwd: "/work" } });
  installClosedViews();
  updatePanel(KEY, (state) => ({ ...state, open: true, surfaces: [{ id: "browser:9", kind: "preview", previewUrl: "http://localhost:5173/" }], activeId: "browser:9" }));
  recordTabViewport("browser:9", { kind: "preset", width: 390, height: 844, presetId: "iphone-14" });
  closeActiveSurfaceAction();
  await until(hasClosedViews);
  expect(closedViews()[0]!.surface.viewport).toEqual({ kind: "preset", width: 390, height: 844, presetId: "iphone-14" });
  expect(reopenClosedView()).toBe(true);
  expect(panelStateFor(KEY).surfaces.find((surface) => surface.id === "browser:9")?.viewport).toEqual({ kind: "preset", width: 390, height: 844, presetId: "iphone-14" });
  // A saved entry with a broken viewport is not trusted.
  expect(isValidClosedView({ id: "x", panelKey: KEY, surface: { id: "browser:1", kind: "preview", viewport: { kind: "freeform", width: -1, height: 2 } } })).toBe(false);
  updatePanel(KEY, (state) => ({ ...state, surfaces: [], activeId: null }));
  overridePanelContext(null);
});

test("fm13: a closed server-hosted browser tab reopens as a new session with its URL, viewport and profile", async () => {
  clearClosedViews();
  const calls: Array<{ method: string; payload: unknown }> = [];
  setReopenRequestForTest(async (method, payload) => { calls.push({ method, payload }); return { tabId: "srv-new" }; });
  serverPreviews.set({ "thread:1": { ...EMPTY_THREAD_PREVIEW, sessions: { "srv-old": { threadId: "thread:1", tabId: "srv-old", navStatus: { _tag: "Success", url: "https://example.com/", title: "" }, canGoBack: false, canGoForward: false, runtime: "server", profileId: "work", updatedAt: "" } } } });
  overridePanelContext({ key: KEY, workspace: { threadId: "thread:1", cwd: "/work" } });
  installClosedViews();
  updatePanel(KEY, (state) => ({ ...state, open: true, surfaces: [{ id: "server-preview:srv-old", kind: "preview", serverTabId: "srv-old", previewUrl: "https://example.com/" }], activeId: "server-preview:srv-old" }));
  recordTabViewport("server-preview:srv-old", { kind: "freeform", width: 800, height: 600 });
  closeActiveSurfaceAction();
  await until(hasClosedViews);
  expect(closedViews()[0]!.surface.profileId).toBe("work");
  expect(reopenClosedView()).toBe(true);
  await until(() => calls.length > 0);
  expect(calls[0]).toEqual({ method: "preview.open", payload: { threadId: "thread:1", runtime: "server", url: "https://example.com/", viewport: { _tag: "freeform", width: 800, height: 600, kind: undefined }, profileId: "work" } });
  await until(() => panelStateFor(KEY).activeId === "server-preview:srv-new");
  expect(panelStateFor(KEY).activeId).toBe("server-preview:srv-new");
  setReopenRequestForTest(null);
  serverPreviews.set({});
  updatePanel(KEY, (state) => ({ ...state, surfaces: [], activeId: null }));
  overridePanelContext(null);
});
