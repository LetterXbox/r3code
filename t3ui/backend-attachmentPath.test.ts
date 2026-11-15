import { expect, test } from "nsh/test";
import { attachmentLocalPath } from "./backend/attachments";

test("a dropped file URL retains its absolute path and decodes spaces", () => {
  expect(attachmentLocalPath("file:///var/folders/a/Screenshot%202026.png", "macos")).toBe("/private/var/folders/a/Screenshot 2026.png");
  expect(attachmentLocalPath("/tmp/already decoded.png", "macos")).toBe("/private/tmp/already decoded.png");
  expect(attachmentLocalPath("/var/folders/a/Screenshot.png", "linux")).toBe("/var/folders/a/Screenshot.png");
  expect(attachmentLocalPath("/various/file", "macos")).toBe("/various/file");
});

test("a file URL cannot name another host", () => {
  let rejected = false;
  try { attachmentLocalPath("file://other-host/private.png"); } catch { rejected = true; }
  expect(rejected).toBe(true);
});
