import { expect, open, test } from "nsh/test";

test("the picker docks an effort column of the model's real levels and the trigger follows the pick", async () => {
  const app = await open("./EffortPickerFixture.tsx", { width: 900, height: 600, platform: "macos" });
  await app.press("label:Select model");
  await expect(app.shows("label:Effort")).toBe(true);
  await expect(app.shows("label:High")).toBe(true);
  await expect(app.shows("label:Low")).toBe(true);
  await app.press("label:High");
  // The popup stays open so the column can follow the model pick.
  await expect(app.shows("label:Search models")).toBe(true);
});

test("the trigger carries the effort detail, with Fast folded into the level and the context window", async () => {
  const app = await open("./EffortPickerFixture.tsx", { width: 900, height: 600, platform: "macos" });
  await app.press("label:Select model");
  await app.press("label:High");
  await app.press("label:Fast");
  await expect(app.shows("label:Select model")).toBe(true);
  await expect(app.texts()).toContain("200k");
  await expect(app.texts()).toContain("Fast");
});

test("a model with no capabilities shows the web's empty effort row, and Options rows expand", async () => {
  const app = await open("./EffortPickerFixture.tsx", { width: 900, height: 600, platform: "macos" });
  await app.press("label:Select model");
  await app.press("label:Context window: 200k");
  await app.press("label:1M");
  await expect(app.texts()).toContain("1M");
  await app.press("label:Provider B");
  await app.press("label:Model B, Provider B");
  await expect(app.texts()).toContain("No effort levels");
});
