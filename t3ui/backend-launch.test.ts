import { expect, test } from "nsh/test";
import { attachmentMimeType, attachmentUploadUrl } from "./backend/attachments";
import { validWorkspaceStrategy } from "./backend/launch";
import { addAttachment, configureBackend, createThread, draftAttachments, removeAttachment, retryAttachment, runtimeMode, setRuntimeMode, setWorkspaceStrategy, workspaceStrategy } from "./store";

test("workspace choices reject an empty base and preserve an explicit branch", () => {
  expect(validWorkspaceStrategy({ type: "worktree", baseRef: " main ", branch: " feature/test ", startFromOrigin: false })).toEqual({ type: "worktree", baseRef: "main", branch: "feature/test", startFromOrigin: false });
  let failed = false;
  try { validWorkspaceStrategy({ type: "worktree", baseRef: "  " }); } catch { failed = true; }
  expect(failed).toBe(true);
});

test("attachment upload URLs cannot leave the connected environment", () => {
  expect(attachmentUploadUrl("ws://127.0.0.1:3777/ws", "/api/attachments/upload/signed")).toBe("http://127.0.0.1:3777/api/attachments/upload/signed");
  let failed = false;
  try { attachmentUploadUrl("ws://127.0.0.1:3777/ws", "https://other.test/api/attachments/upload/signed"); } catch { failed = true; }
  expect(failed).toBe(true);
  expect(attachmentMimeType("example.pdf", "")).toBe("application/pdf");
});

test("mode, workspace, and a failed offline attachment remain with their draft", async () => {
  createThread(null);
  await setRuntimeMode("approval-required");
  setWorkspaceStrategy({ type: "worktree", baseRef: "main" });
  await addAttachment(new File(["document"], "notes.txt", { type: "text/plain" }));
  const attachment = draftAttachments()[0];
  expect(attachment.name).toBe("notes.txt");
  let failed = false;
  try { await retryAttachment(attachment.id); } catch { failed = true; }
  expect(failed).toBe(true);
  expect(draftAttachments().length).toBe(1);
  expect(runtimeMode()).toBe("approval-required");
  expect(workspaceStrategy()).toEqual({ type: "worktree", baseRef: "main" });
  removeAttachment(attachment.id);
  expect(draftAttachments().length).toBe(0);
  configureBackend("");
});
