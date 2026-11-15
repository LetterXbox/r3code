import { expect, test } from "nsh/test";
import { addAttachment, composerDraft, configureBackend, createThread, draftAttachments, setComposerDraft } from "./store";
import { ATTACHMENT_UPLOAD_COULD_NOT_START, ATTACHMENT_UPLOAD_FAILED, attachmentUploadRejected, attachmentBlockReason, attachmentsToReleaseOnUploadCapabilityLoss, fileAttachmentCapabilityBlockReason, fileAttachmentStagingLimit } from "./components/composer/attachmentIntake";
import { attachmentReferencedIn, stripInlineContextReferences } from "./components/composer/contextChips";
import { isVideoAttachment, videoMimeType } from "./backend/attachments";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));

test("a video keeps its video type when the source gave none or a generic one; other types are not videos", () => {
  expect(videoMimeType({ name: "clip.mov", mimeType: "" })).toBe("video/quicktime");
  expect(videoMimeType({ name: "clip.webm", mimeType: "application/octet-stream" })).toBe("video/webm");
  expect(videoMimeType({ name: "x.bin", mimeType: "video/mp4; codecs=avc1" })).toBe("video/mp4");
  expect(videoMimeType({ name: "clip.mp4", mimeType: "text/plain" })).toBeNull();
  expect(isVideoAttachment({ name: "notes.txt", mimeType: "text/plain" })).toBe(false);
});

test("an image gets an inline chip only when the prompt has text of its own; a file always does", async () => {
  configureBackend("ws://127.0.0.1:37811/ws");
  createThread(null);
  await addAttachment(new File([PNG], "first.png", { type: "image/png" }));
  expect(composerDraft()).toBe("");
  await addAttachment(new File(["hi"], "a.txt", { type: "text/plain" }));
  expect(composerDraft()).toContain("[a.txt](t3-context://v1/file/");
  // A prompt holding only chips is still empty text: the next image stays chipless.
  await addAttachment(new File([PNG], "second.png", { type: "image/png" }));
  expect(composerDraft()).not.toContain("second.png");
  setComposerDraft("look at this");
  await addAttachment(new File([PNG], "third.png", { type: "image/png" }));
  expect(composerDraft()).toContain("[third.png](t3-context://v1/image/");
  const [first, , , third] = draftAttachments();
  expect(attachmentReferencedIn(composerDraft(), first!)).toBe(false);
  expect(attachmentReferencedIn(composerDraft(), third!)).toBe(true);
  expect(stripInlineContextReferences(composerDraft()).trim()).toBe("look at this");
  await addAttachment(new File([new Uint8Array(9)], "clip.mov", { type: "" }));
  expect(draftAttachments().at(-1)).toMatchObject({ name: "clip.mov", kind: "file", mimeType: "video/quicktime" });
});

test("send blocks: waiting for the server, files refused, too large, interrupted files, and questions on an old server", () => {
  const files = [{ name: "a.zip", sizeBytes: 10 }];
  const base = { known: true, supported: true, maxFileBytes: 100 };
  expect(fileAttachmentCapabilityBlockReason({ ...base, known: false, files })).toBe("Waiting for the server before file attachments can send");
  expect(fileAttachmentCapabilityBlockReason({ ...base, maxFileBytes: null, files })).toBe("This server does not accept file attachments right now. Remove the files to send.");
  expect(fileAttachmentCapabilityBlockReason({ ...base, supported: false, files })).toBe("This server does not accept file attachments right now. Remove the files to send.");
  expect(fileAttachmentCapabilityBlockReason({ ...base, maxFileBytes: 5, files })).toBe("'a.zip' exceeds the 5 bytes attachment limit.");
  expect(fileAttachmentCapabilityBlockReason({ ...base, files: [] })).toBeNull();
  expect(fileAttachmentStagingLimit({ known: false, supported: false, maxFileBytes: null })).toBe(50 * 1024 * 1024);
  expect(fileAttachmentStagingLimit({ known: true, supported: true, maxFileBytes: 1 << 30 })).toBe(50 * 1024 * 1024);
  const extra = { ...base, files: [], questionWithoutAttachmentSupport: false, hasAttachments: true };
  expect(attachmentBlockReason({ ...extra, needsReattachCount: 1 })).toBe("Attach the interrupted file again or remove it");
  expect(attachmentBlockReason({ ...extra, needsReattachCount: 2 })).toBe("Attach the interrupted files again or remove them");
  expect(attachmentBlockReason({ ...extra, supported: false, needsReattachCount: 2 })).toBeNull();
  expect(attachmentBlockReason({ ...extra, questionWithoutAttachmentSupport: true, needsReattachCount: 0 })).toBe("Update this server to send files with question answers");
  expect(attachmentBlockReason({ ...extra, questionWithoutAttachmentSupport: true, hasAttachments: false, needsReattachCount: 0 })).toBeNull();
});

test("capability loss releases only unpersisted uploads", () => {
  const file = new File(["x"], "x");
  const items = [
    { id: "img-uploaded", kind: "image" as const, status: "uploaded", uploadedId: "s1", file },
    { id: "file-uploaded", kind: "file" as const, status: "uploaded", uploadedId: "s2", file },
    { id: "file-uploading", kind: "file" as const, status: "uploading", file },
    { id: "file-hydrated", kind: "file" as const, status: "ready", uploadedId: "s3" },
    { id: "img-hydrated", kind: "image" as const, status: "uploaded", uploadedId: "s4" },
    { id: "idle", kind: "file" as const, status: "ready", file },
  ];
  expect(attachmentsToReleaseOnUploadCapabilityLoss(items).map((item) => item.id)).toEqual(["img-uploaded", "file-uploading"]);
});

test("upload failure reasons match the reference queue copy", () => {
  expect(ATTACHMENT_UPLOAD_COULD_NOT_START).toBe("Upload could not start");
  expect(ATTACHMENT_UPLOAD_FAILED).toBe("Upload failed");
  expect(attachmentUploadRejected(413)).toBe("Upload rejected (413)");
});
