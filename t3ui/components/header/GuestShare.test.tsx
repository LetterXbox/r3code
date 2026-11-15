import { expect, open, test } from "nsh/test";

test("a guest's waiting messages show under their name with Dismiss and Send, and each resolves on its own", async () => {
  const app = await open("./GuestShareFixture.tsx", { width: 700, height: 600, platform: "macos" });
  await expect(app.texts()).toContain("Ada (guest)");
  await expect(app.texts()).toContain("Can you also add tests?");
  await expect(app.texts()).toContain("log.txt");
  // GuestMessageAttachments: a file row carries its size and previews on press; an image is a thumbnail tile.
  await expect(app.texts()).toContain("2 KB");
  await expect(app.shows("label:Preview log.txt")).toBe(true);
  await expect(app.shows("label:Preview shot.png")).toBe(true);
  await expect(app.shows("label:2 guest messages waiting")).toBe(true);
  await app.press("label:Send message from Ada >> nth=0");
  await expect(app.texts()).toContain("send gm-1");
  await expect(app.shows("label:1 guest message waiting")).toBe(true);
  await app.press("label:Dismiss message from Ada");
  await expect(app.texts()).toContain("dismiss gm-2");
  await expect(app.shows("label:Dismiss message from Ada")).toBe(false);
});

test("the share dialog explains the guest's view and the link's lifetime, and Cancel closes it", async () => {
  const app = await open("./GuestShareFixture.tsx", { width: 700, height: 600, platform: "macos" });
  await app.press("label:Open share dialog");
  await app.waitFor("label:Share with guest");
  await expect(app.texts().some((text) => text.includes("The guest sees the thread as you do"))).toBe(true);
  await expect(app.texts()).toContain("The link works once and expires in 24 hours.");
  await app.press("label:Cancel");
  await expect(app.shows("label:Share with guest")).toBe(false);
});
