import { expect, open, test } from "nsh/test";

test("an image attachment loads its real bytes and opens the preview when pressed", async () => {
  const app = await open("./MessageMediaFixture.tsx", { width: 600, height: 600 });
  await app.waitFor("text:Loaded one");
  await app.waitFor("label:one.png");
  await app.press("label:Preview one.png");
  await expect(app.texts()).toContain("Opened one");
});

test("several images share one collage and each opens on its own", async () => {
  const app = await open("./MessageMediaFixture.tsx", { width: 600, height: 600 });
  await app.press("label:Three images");
  await app.waitFor("text:Loaded one,a,b,c");
  await expect(app.shows("label:Image attachments")).toBe(true);
  await app.press("label:Preview b.png");
  await expect(app.texts()).toContain("Opened b");
});

test("an image that cannot load falls back to its name, and files show as cards", async () => {
  const app = await open("./MessageMediaFixture.tsx", { width: 600, height: 600 });
  await app.press("label:Broken and file");
  await app.waitFor("text:lost.png");
  await expect(app.texts()).toContain("report.pdf");
  await expect(app.texts()).toContain("PDF · 2 KB");
});

test("video and audio attachments load their bytes into players, and one too large for inline play says so", async () => {
  const app = await open("./MessageMediaFixture.tsx", { width: 600, height: 800 });
  await app.press("label:Video and audio");
  await app.waitFor("text:Loaded one,v1,a1");
  await expect(app.shows("label:Video clip.mp4")).toBe(true);
  await expect(app.shows("label:Audio note.m4a")).toBe(true);
  await expect(app.shows("label:Play audio")).toBe(true);
  await expect(app.texts()).toContain("0:00 / 0:00");
  // 900 MB is over the inline limit: the video card keeps its name and offers a retry instead of a player.
  await expect(app.texts()).toContain("huge.mov");
  await app.press("label:Play audio");
  await expect(app.shows("label:Pause audio")).toBe(true);
});
