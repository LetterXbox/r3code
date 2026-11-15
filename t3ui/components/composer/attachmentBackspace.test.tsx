import { expect, open, test } from "nsh/test";

test("backspace at an attached file does not add a status line and removes the attachment", async () => {
  const app = await open("./AttachmentBackspaceFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.waitUntil(() => app.texts().includes("attachments:1"));
  await app.type("id:composer-prompt", "");
  await app.keyboard.press("end");
  await app.keyboard.press("backspace");
  await expect(app.shows("id:composer-token-detail")).toBe(false);
  await app.keyboard.press("backspace");
  await app.waitUntil(() => app.texts().includes("attachments:0"));
  await expect(app.texts()).toContain('draft:""');
});
