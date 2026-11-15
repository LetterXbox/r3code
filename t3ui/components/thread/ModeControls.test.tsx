import { expect, open, test } from "nsh/test";

test("the permissions chip shows only off the default and its popover switches modes", async () => {
  const app = await open("./ModeFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await expect(app.shows("label:Permissions: Supervised")).toBe(true);
  await app.press("label:Permissions: Supervised >> nth=0");
  await expect(app.texts()).toContain("Ask before commands and file changes.");
  await app.press("label:Full access");
  await expect(app.texts()).toContain("Full access");
});

test("the picker footer has no Default/Plan control (the reference has none) and keeps Permissions", async () => {
  const app = await open("./ModeFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await expect(app.shows("label:Interaction mode: Plan")).toBe(false);
  await expect(app.shows("label:Interaction mode: Default")).toBe(false);
  await expect(app.shows("label:Permissions: Supervised")).toBe(true);
});

test("composer.mode opens the permissions chip's popover from outside", async () => {
  const app = await open("./ModeFixture.tsx", { width: 800, height: 600, platform: "macos" });
  await expect(app.texts()).not.toContain("Ask before commands and file changes.");
  await app.press("label:composer.mode");
  await app.waitUntil(() => app.texts().includes("Ask before commands and file changes."));
});
