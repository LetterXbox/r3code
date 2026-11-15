import { expect, test } from "nsh/test";
import { addAttachment, configureBackend, createThread, draftAttachments } from "../../store";

test("the same file added twice stays one attachment (composerFileDedupKey)", async () => {
  configureBackend("ws://127.0.0.1:37913/ws");
  createThread(null);
  await addAttachment(new File(["notes"], "notes.txt", { type: "text/plain" }));
  await addAttachment(new File(["notes"], "notes.txt", { type: "text/plain" }));
  await addAttachment(new File(["other"], "other.txt", { type: "text/plain" }));
  expect(draftAttachments().map((item) => item.name)).toEqual(["notes.txt", "other.txt"]);
});

test("an empty file is refused with the reference's copy (useComposerAttachmentIntake)", async () => {
  configureBackend("ws://127.0.0.1:37915/ws");
  createThread(null);
  let error = "";
  try { await addAttachment(new File([], "empty.txt", { type: "text/plain" })); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  expect(error).toBe("'empty.txt' is empty or could not be read.");
});

test("an image type providers cannot take is refused unless it previews as a file (classifyComposerAttachmentFile)", async () => {
  const { isUnsupportedComposerImage } = await import("../../store");
  expect(isUnsupportedComposerImage("x.xcf", "image/x-xcf")).toBe(true);
  expect(isUnsupportedComposerImage("x.bmp", "image/bmp")).toBe(false);
  expect(isUnsupportedComposerImage("x.svg", "image/svg+xml")).toBe(false);
  expect(isUnsupportedComposerImage("x.png", "image/png")).toBe(false);
  expect(isUnsupportedComposerImage("x.txt", "text/plain")).toBe(false);
});
