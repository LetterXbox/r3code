import { expect, test } from "nsh/test";
import { handOffAttachmentPreview, takeAttachmentPreviewHandoff } from "./attachmentPreviewHandoff";

test("a sent image's staged bytes are handed to the timeline once, under its server id; files are not", () => {
  handOffAttachmentPreview("att-1", new Blob(["png"], { type: "image/png" }), "image");
  handOffAttachmentPreview("att-2", new Blob(["pdf"], { type: "application/pdf" }), "file");
  const url = takeAttachmentPreviewHandoff("att-1");
  expect(typeof url).toBe("string");
  expect(takeAttachmentPreviewHandoff("att-1")).toBe(undefined);
  expect(takeAttachmentPreviewHandoff("att-2")).toBe(undefined);
});
