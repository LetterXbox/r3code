import { expect, open, test } from "nsh/test";

test("an anchored copy toast appears under its button and goes after a second", async () => {
  const app = await open("./ToastExtrasFixture.tsx", { width: 1000, height: 700 });
  await app.press("label:Copy path");
  await app.waitFor("text:Copied!");
  await app.waitUntil(() => !app.texts().includes("Copied!"));
});

test("a failed copy stays until dismissed and gives the reason", async () => {
  const app = await open("./ToastExtrasFixture.tsx", { width: 1000, height: 700 });
  await app.press("label:Copy fails");
  await app.waitFor("text:Failed to copy");
  await expect(app.texts()).toContain("Clipboard is unavailable");
  await app.press("label:Dismiss notification");
  // The popup plays its 150ms scale and fade out before it goes (ui/toast.tsx:740).
  await app.waitUntil(() => !app.texts().includes("Failed to copy"));
});

test("a thread notification shows its title, the thread and an Open thread action, and no copy button", async () => {
  const app = await open("./ToastExtrasFixture.tsx", { width: 1000, height: 700 });
  await app.press("label:Notify");
  await app.waitFor("text:Approval needed");
  await expect(app.texts()).toContain("Fix the build");
  await expect(app.shows("label:Copy error")).toBe(false);
  await app.press("label:Open thread");
  await app.waitFor("text:log open thread-1");
});

test("the slow requests toast lists its requests behind Show requests", async () => {
  const app = await open("./ToastExtrasFixture.tsx", { width: 1000, height: 700 });
  await app.press("label:Slow");
  await app.waitFor("text:Some requests are slow");
  await expect(app.texts()).toContain("1 request waiting longer than 15s.");
  await expect(app.texts()).not.toContain("server.getConfig");
  await app.press("label:Show requests");
  await app.waitFor("text:server.getConfig");
  await app.press("label:Hide requests");
  await expect(app.texts()).not.toContain("server.getConfig");
});
