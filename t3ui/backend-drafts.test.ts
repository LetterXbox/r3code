import { expect, test } from "nsh/test";
import {
  addAttachment, backendError, canUndoDiscardDraft, composerDraft, configureBackend, createThread, discardDraft,
  draftAttachments, draftSummary, openThread, openThreadById, runtimeMode, setComposerDraft, setRuntimeMode,
  setWorkspaceStrategy, sidebarDrafts, undoDiscardDraft, workspaceStrategy,
} from "./store";

test("discard and undo preserve a draft's contents, attachments and workspace", async () => {
  configureBackend("ws://127.0.0.1:37801/ws");
  createThread(null);
  const id = openThread()?.id ?? "";
  setComposerDraft("Keep this text");
  await addAttachment(new File(["notes"], "notes.txt", { type: "text/plain" }));
  await setRuntimeMode("approval-required");
  setWorkspaceStrategy({ type: "worktree", baseRef: "main" });
  // An attached file also leaves its inline chip in the prompt (useComposerAttachmentIntake insertAttachmentReferences).
  const kept = draftSummary(id).text;
  expect(kept.startsWith("Keep this text [notes.txt](t3-context://v1/file/")).toBe(true);
  expect(draftSummary(id).attachmentCount).toBe(1);
  await discardDraft(id);
  expect(sidebarDrafts().some((draft) => draft.id === id)).toBe(false);
  expect(canUndoDiscardDraft()).toBe(true);
  await undoDiscardDraft();
  expect(openThread()?.id).toBe(id);
  expect(composerDraft()).toBe(kept);
  expect(draftAttachments().map((item) => item.name)).toEqual(["notes.txt"]);
  expect(runtimeMode()).toBe("approval-required");
  expect(workspaceStrategy()).toEqual({ type: "worktree", baseRef: "main" });
  expect(canUndoDiscardDraft()).toBe(false);
});

test("discard undo is scoped to its original environment", async () => {
  const a = "ws://127.0.0.1:37802/ws";
  const b = "ws://127.0.0.1:37803/ws";
  configureBackend(a);
  createThread(null);
  const draftA = openThread()?.id ?? "";
  setComposerDraft("Environment A");
  await discardDraft(draftA);
  configureBackend(b);
  expect(canUndoDiscardDraft()).toBe(false);
  createThread(null);
  const draftB = openThread()?.id ?? "";
  setComposerDraft("Environment B");
  await discardDraft(draftB);
  configureBackend(a);
  expect(canUndoDiscardDraft()).toBe(true);
  await undoDiscardDraft();
  expect(openThread()?.id).toBe(draftA);
  expect(composerDraft()).toBe("Environment A");
  configureBackend(b);
  await undoDiscardDraft();
  expect(openThread()?.id).toBe(draftB);
  expect(composerDraft()).toBe("Environment B");
});

test("undo does not interrupt navigation and unknown drafts fail safely", async () => {
  configureBackend("ws://127.0.0.1:37804/ws");
  createThread(null);
  const first = openThread()?.id ?? "";
  setComposerDraft("First");
  createThread(null);
  const second = openThread()?.id ?? "";
  setComposerDraft("Second");
  await discardDraft(first);
  openThreadById(second);
  await undoDiscardDraft();
  expect(openThread()?.id).toBe(second);
  expect(draftSummary(first).text).toBe("First");
  let failed = false;
  try { await discardDraft("not-a-draft"); } catch { failed = true; }
  expect(failed).toBe(true);
  expect(backendError()).toBe("This draft is no longer available");
  expect(draftSummary(first).text).toBe("First");
});

test("consecutive discarded drafts can be restored in reverse order", async () => {
  configureBackend("ws://127.0.0.1:37805/ws");
  createThread(null);
  const first = openThread()?.id ?? "";
  setComposerDraft("First draft");
  createThread(null);
  const second = openThread()?.id ?? "";
  setComposerDraft("Second draft");
  await discardDraft(second);
  await discardDraft(first);
  await undoDiscardDraft();
  expect(openThread()?.id).toBe(first);
  expect(composerDraft()).toBe("First draft");
  expect(canUndoDiscardDraft()).toBe(true);
  await undoDiscardDraft();
  expect(openThread()?.id).toBe(second);
  expect(composerDraft()).toBe("Second draft");
  expect(canUndoDiscardDraft()).toBe(false);
});
