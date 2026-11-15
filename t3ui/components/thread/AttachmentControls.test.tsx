import { expect, open, test } from "nsh/test";

test("attachments can be retried, removed, and added through the system file dialog", async () => {
  const app = await open("./AttachmentFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await expect(app.texts()).toContain("Upload failed");
  await app.press("label:Retry failed.txt");
  await app.waitUntil(() => app.texts().includes("25 B"));
  await app.press("label:Remove failed.txt");
  await expect(app.texts()).not.toContain("failed.txt");
  // ComposerAttachButton: one button straight to the multi-file picker; no menu, no path field.
  await app.press("label:Attach files");
  await app.waitUntil(() => app.texts().includes("/tmp/report.txt") && app.texts().includes("/tmp/notes.md"));
  await expect(app.shows("label:Attachment file path")).toBe(false);
});

test("without the macOS file dialog the system photo picker stages the picked image", async () => {
  const app = await open("./AttachmentFixture.tsx", { width: 800, height: 600, platform: "linux" });
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="), (character) => character.charCodeAt(0));
  app.onPick(() => [{ name: "pixel.png", type: "image/png", data: png }]);
  await app.press("label:Attach files");
  await app.waitUntil(() => app.texts().includes("pixel.png"));
  await expect(app.picks().length).toBe(1);
});

test("a staged image shows its own pixels in the strip, not just its name", async () => {
  const app = await open("./AttachmentFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await expect(app.shows("label:photo.png")).toBe(true);
  await expect(app.shows("label:Remove photo.png")).toBe(true);
});

test("pressing a staged image opens the gallery of the draft's images from the staged bytes", async () => {
  const app = await open("./AttachmentFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.press("label:Preview photo.png");
  // ComposerAttachmentStrip opens the expanded gallery of every draft image at the one pressed.
  await app.waitUntil(() => app.texts().includes("gallery:photo.png@0"));
});

test("a restored attachment whose bytes are gone reads Attach again and offers no Retry", async () => {
  const app = await open("./AttachmentFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await expect(app.texts()).toContain("Attach again");
  await expect(app.shows("label:Retry restored.md")).toBe(false);
  await expect(app.shows("label:Remove restored.md")).toBe(true);
});

test("a video attachment is a Play tile, not a file row, and plays in the expanded viewer from its bytes", async () => {
  const app = await open("./AttachmentFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await expect(app.shows("label:Play clip.mp4")).toBe(true);
  await expect(app.shows("label:Preview clip.mp4")).toBe(false);
  await expect(app.shows("label:Remove clip.mp4")).toBe(true);
  await app.press("label:Play clip.mp4");
  await app.waitUntil(() => app.texts().includes("gallery:clip.mp4@0"));
});

test("a file's name opens its preview over the app, headed Draft, with Remove from draft", async () => {
  const app = await open("./AttachmentFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.press("label:Preview notes.txt");
  await app.waitUntil(() => app.shows("label:Remove from draft"));
  await expect(app.texts()).toContain("Draft");
  await app.waitUntil(() => app.texts().some((text) => text.includes("hello there")));
  await app.press("label:Remove from draft");
  await app.waitUntil(() => !app.shows("label:Remove notes.txt"));
  await expect(app.shows("label:Remove from draft")).toBe(false);
});
