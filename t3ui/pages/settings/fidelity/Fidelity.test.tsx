import { expect, open, test } from "nsh/test";

test("SnapShots is the desktop client's page: never the desktop-only group; enabling opens the macOS setup wizard", async () => {
  const app = await open("./PanelsFixture.tsx", { width: 1100, height: 3000, platform: "macos" });
  await expect(app.texts()).not.toContain("Only available in the desktop app.");
  await expect(app.texts()).toContain("Capture a window and attach it to your current draft.");
  await app.waitUntil(() => app.texts().includes("Turn this on to set up snapshots."));
  await expect(app.shows("id:Enable snapshots (off)")).toBe(true);
  await app.press("label:Enable snapshots");
  await app.waitFor("id:SnapShot setup dialog");
  await expect(app.texts()).toContain("Allow snapshots");
  await expect(app.texts()).toContain("Screen Recording");
  await expect(app.texts()).toContain("Test capture and continue");
  await expect(app.shows("id:Permission Screen Recording (not granted)")).toBe(true);
  await expect(app.texts()).toContain("Finish later");
});

test("Snooze options is an editor: rows with a preview, a menu line, add and remove, written to the server", async () => {
  const app = await open("./PanelsFixture.tsx", { width: 1100, height: 3000 });
  await expect(app.texts()).toContain("Choices in every snooze menu, listed soonest first. Weekdays mean the next one after today.");
  await expect(app.shows("label:Snooze option 2")).toBe(true);
  await expect(app.texts().some((text) => text.startsWith("Menu now: In 1 hour"))).toBe(true);
  await app.press("label:Add option");
  await app.waitFor("label:Snooze option 3");
  await app.waitUntil(() => app.texts().some((text) => text.startsWith("write server.updateSettings") && text.includes('"minutes":180')));
  await app.press("label:Remove snooze option 3");
  await app.waitFor("label:Snooze option 3", { state: "gone" });
  await app.press("label:Reset Snooze options to default");
});
