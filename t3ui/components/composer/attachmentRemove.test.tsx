import { expect, open, test } from "nsh/test";

test("removing an image the prompt references asks first; one with no chip goes at once", async () => {
  const app = await open("./AttachmentRemoveFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await app.waitUntil(() => app.texts().includes("attachments:plain.png,shot.png"));
  await expect(app.texts()).toContain("chipped:true");
  // useComposerAttachmentIntake removeComposerImage: the referenced image confirms, and Cancel keeps it.
  await app.press("label:Remove shot.png");
  await app.waitUntil(() => app.texts().includes("Remove shot.png from the message?"));
  await expect(app.texts().some((text) => text.includes("It is referenced in your text; removing it also removes every reference."))).toBe(true);
  await app.press("label:Cancel");
  await app.waitUntil(() => !app.texts().includes("Remove shot.png from the message?"));
  await expect(app.texts()).toContain("attachments:plain.png,shot.png");
  // Confirming removes it and its chip.
  await app.press("label:Remove shot.png");
  await app.waitUntil(() => app.texts().includes("Remove shot.png from the message?"));
  await app.press("label:Confirm");
  await app.waitUntil(() => app.texts().includes("attachments:plain.png"));
  await expect(app.texts()).toContain("chipped:false");
  // An image no chip references has nothing to confirm.
  await app.press("label:Remove plain.png");
  await app.waitUntil(() => app.texts().includes("attachments:"));
  await expect(app.texts().some((text) => text.includes("Remove plain.png from the message?"))).toBe(false);
});
