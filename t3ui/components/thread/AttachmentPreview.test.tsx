import { expect, open, test } from "nsh/test";

test("text attachments preview inside the app and close", async () => {
  const app = await open("./AttachmentPreviewFixture.tsx", { width: 800, height: 600 });
  await app.press("label:Open text preview");
  await app.waitFor("text:hello world");
  await expect(app.texts()).toContain("notes.txt");
  await app.press("label:Close attachment preview");
  await expect(app.texts()).not.toContain("hello world");
});

test("closing an in-flight attachment preview aborts the load", async () => {
  const app = await open("./AttachmentPreviewFixture.tsx", { width: 800, height: 600 });
  await app.press("label:Open slow preview");
  await expect(app.texts()).toContain("Loading preview...");
  await app.press("label:Close attachment preview");
  await app.waitFor("text:Load cancelled");
});

test("image attachments are shown in the in-app preview", async () => {
  const app = await open("./AttachmentPreviewFixture.tsx", { width: 800, height: 600 });
  await app.press("label:Open image preview");
  await app.waitFor("label:Attachment image preview");
  await expect(app.texts()).toContain("pixel.png");
  await app.press("label:Close attachment preview");
  await expect(app.shows("label:Attachment image preview")).toBe(false);
});


test("the image backdrop dismisses the window-wide preview", async () => {
  const app = await open("./AttachmentPreviewFixture.tsx", { width: 800, height: 600 });
  await app.press("label:Open image preview");
  await app.waitFor("label:Attachment image preview");
  await app.press("id:Attachment preview backdrop");
  await expect(app.shows("label:Attachment image preview")).toBe(false);
});

import { attachmentPreviewSize } from "./attachmentPreviewLayout";
test("expanded image sizing preserves aspect ratio, avoids enlargement and fits portrait or landscape windows", () => {
  expect(attachmentPreviewSize({ width: 1000, height: 800 }, { width: 700, height: 256 })).toEqual({ width: 700, height: 256 });
  expect(attachmentPreviewSize({ width: 1000, height: 800 }, { width: 2000, height: 1000 })).toEqual({ width: 824, height: 412 });
  expect(attachmentPreviewSize({ width: 1000, height: 800 }, { width: 400, height: 2000 })).toEqual({ width: 128, height: 640 });
});
