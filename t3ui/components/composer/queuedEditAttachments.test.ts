import { expect, test } from "nsh/test";
import { editedQueuedAttachments, queueEditing, removeEditingQueuedAttachment } from "./queueState";

const file = (id: string) => ({ id, name: `${id}.txt`, mimeType: "text/plain", sizeBytes: 3, type: "file" });

test("a queued edit keeps its attachments unless one is removed", () => {
  queueEditing.set({ threadId: "t1", runId: "r1", stash: "", attachments: [file("a"), file("b")], originalAttachmentCount: 2 });
  expect(editedQueuedAttachments(queueEditing()!)).toBe(undefined);
  removeEditingQueuedAttachment("a");
  expect(queueEditing()!.attachments!.map((item) => item.id)).toEqual(["b"]);
  expect(editedQueuedAttachments(queueEditing()!)!.map((item) => item.id)).toEqual(["b"]);
  removeEditingQueuedAttachment("b");
  expect(editedQueuedAttachments(queueEditing()!)).toEqual([]);
  queueEditing.set(null);
  removeEditingQueuedAttachment("b");
  expect(queueEditing()).toBe(null);
});
