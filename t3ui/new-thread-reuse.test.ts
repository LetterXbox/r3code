import { expect, test } from "nsh/test";
import { composerDraft, configureBackend, createThread, interactionMode, openThread, setComposerDraft, setInteractionMode } from "./store";

test("new thread reuses the project's empty draft and keeps one with text", () => {
  configureBackend("ws://127.0.0.1:37851/ws");
  createThread(null);
  const first = openThread()?.id ?? "";
  createThread(null);
  expect(openThread()?.id).toBe(first);
  setComposerDraft("Keep me");
  createThread(null);
  expect(openThread()?.id).not.toBe(first);
});

test("new thread seeds the prompt and carries the interaction mode", async () => {
  configureBackend("ws://127.0.0.1:37852/ws");
  createThread(null, { prompt: "Seeded" });
  expect(composerDraft()).toBe("Seeded");
  await setInteractionMode("plan").catch(() => undefined);
  const mode = interactionMode();
  setComposerDraft("x");
  createThread(null);
  expect(interactionMode()).toBe(mode);
});

test("sidebar open state is written to chat_thread_sidebar_open on toggle", async () => {
  const { Storage } = await import("nsh");
  const { loadSidebarOpen, sidebarOpen, toggleSidebar, SIDEBAR_OPEN_STORAGE_KEY } = await import("./store");
  await loadSidebarOpen();
  const before = sidebarOpen();
  toggleSidebar();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(await Storage.getItem(SIDEBAR_OPEN_STORAGE_KEY)).toBe(String(!before));
  toggleSidebar();
});

test("a project whose default env mode is worktree starts its new draft on a worktree of the current branch", async () => {
  const { applyConfigEventForTest, applyShellEventForTest, setBackendStatusForTest, setRequestBackendForTest, workspaceStrategy, openThread: open } = await import("./store");
  const iso = new Date().toISOString();
  setRequestBackendForTest(async (method) => method === "vcs.listRefs"
    ? { isRepo: true, refs: [{ name: "main", current: false, isRemote: false }, { name: "feature", current: true, isRemote: false }] }
    : {});
  setBackendStatusForTest("connected");
  applyConfigEventForTest({ type: "snapshot", config: { providers: [], settings: { defaultThreadEnvMode: "worktree", newWorktreesStartFromOrigin: true } } });
  applyShellEventForTest({ kind: "snapshot", snapshot: { projects: [{ id: "project-wt", title: "wt", workspaceRoot: "/work/wt", createdAt: iso, updatedAt: iso }], threads: [] } });
  createThread("project-wt");
  for (let attempt = 0; attempt < 100 && workspaceStrategy().type !== "worktree"; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(open()?.projectId).toBe("project-wt");
  expect(workspaceStrategy()).toEqual({ type: "worktree", baseRef: "feature", startFromOrigin: true });
});
