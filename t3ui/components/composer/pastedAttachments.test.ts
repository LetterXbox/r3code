import { expect, test } from "nsh/test";
import { attachmentMarker } from "./contextChips";
import { importPastedAttachments, pastedAttachmentContextIds, withoutAttachmentChip } from "./pastedAttachments";
import { addAttachment, applyShellEventForTest, composerDraftFor, draftAttachmentsFor, openThreadById, removeAttachment, setBackendStatusForTest, setComposerDraft } from "../../store";

test("pasted image and file chips are found by context id and can be taken out of the prompt", () => {
  const image = attachmentMarker({ id: "a1", kind: "image", name: "shot.png" });
  const file = attachmentMarker({ id: "f1", kind: "file", name: "notes.txt" });
  const text = `look ${image} and ${file} plus [#1](t3-context://v1/review-comment/pr-1) `;
  const ids = pastedAttachmentContextIds(text);
  expect(ids).toEqual(["image_a1", "file_f1"]);
  expect(withoutAttachmentChip(text, "image_a1")).toBe(`look and ${file} plus [#1](t3-context://v1/review-comment/pr-1) `);
  expect(pastedAttachmentContextIds("no chips")).toEqual([]);
});

import { pendingDraftWork } from "./pastedAttachments";

test("pending draft work is counted per draft, so overlapping imports do not release each other", () => {
  pendingDraftWork.begin("d1"); pendingDraftWork.begin("d1");
  pendingDraftWork.end("d1");
  expect(pendingDraftWork.has("d1")).toBe(true);
  pendingDraftWork.end("d1");
  expect(pendingDraftWork.has("d1")).toBe(false);
});

test("an attachment import updates its originating draft after another thread is opened", async () => {
  setBackendStatusForTest("disconnected");
  const createdAt = "2026-01-01T00:00:00.000Z";
  applyShellEventForTest({ kind: "snapshot", snapshot: { projects: [], threads: ["paste-source", "paste-target", "paste-other"].map((id) => ({ id, title: id, projectId: "missing", createdAt, updatedAt: createdAt })) } });
  openThreadById("paste-source");
  await addAttachment(new File(["image"], "shot.png", { type: "image/png" }));
  const source = draftAttachmentsFor("paste-source")[0]!;
  const marker = attachmentMarker({ id: source.id, kind: "image", name: source.name });
  openThreadById("paste-target");
  setComposerDraft(`target ${marker}`);
  openThreadById("paste-other");
  setComposerDraft("other draft");
  expect(await importPastedAttachments("paste-target", marker)).toBe(1);
  expect(composerDraftFor("paste-other")).toBe("other draft");
  expect(composerDraftFor("paste-target")).toContain("target");
  expect(draftAttachmentsFor("paste-target").length).toBe(1);
  openThreadById("paste-target");
  removeAttachment(draftAttachmentsFor("paste-target")[0]!.id);
  setComposerDraft(`again ${marker}`);
  expect(await importPastedAttachments("paste-target", marker)).toBe(1);
  expect(draftAttachmentsFor("paste-target").length).toBe(1);
});

test("an import does not reinsert an attachment removed while its bytes are loading", async () => {
  openThreadById("paste-target");
  const source = draftAttachmentsFor("paste-source")[0]!;
  const marker = attachmentMarker({ id: source.id, kind: "image", name: source.name });
  const count = draftAttachmentsFor("paste-target").length;
  setComposerDraft(marker);
  let finish!: (blob: Blob) => void;
  const importing = importPastedAttachments("paste-target", marker, () => new Promise((resolve) => { finish = resolve; }));
  expect(pendingDraftWork.has("paste-target")).toBe(true);
  setComposerDraft("marker removed while loading");
  finish(new Blob(["image"], { type: "image/png" }));
  expect(await importing).toBe(0);
  expect(draftAttachmentsFor("paste-target").length).toBe(count);
  expect(composerDraftFor("paste-target")).toBe("marker removed while loading");
  expect(pendingDraftWork.has("paste-target")).toBe(false);
});

test("failed attachment intake leaves the pasted marker in the draft for retry", async () => {
  openThreadById("paste-target");
  const source = draftAttachmentsFor("paste-source")[0]!;
  const marker = attachmentMarker({ id: source.id, kind: "image", name: source.name });
  setComposerDraft(`keep ${marker}`);
  expect(await importPastedAttachments("paste-target", marker, async () => new Blob([]))).toBe(0);
  expect(composerDraftFor("paste-target")).toBe(`keep ${marker}`);
  expect(pendingDraftWork.has("paste-target")).toBe(false);
});
