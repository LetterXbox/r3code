import { expect, open, test } from "nsh/test";

const options = { width: 1280, height: 800, platform: "macos" as const };

test("the header has Go back and Go forward, both disabled before anything was visited", async () => {
  const app = await open("../../App.tsx", options);
  await expect(app.shows("label:Go back")).toBe(true);
  await expect(app.shows("label:Go forward")).toBe(true);
  await expect(app.enabled("label:Go back")).toBe(false);
  await expect(app.enabled("label:Go forward")).toBe(false);
});

test("opening a page enables Go back, and back then forward walks the pages", async () => {
  const app = await open("../../App.tsx", options);
  await app.press("label:Usage");
  await app.waitFor("text:Connect an environment to see limits.");
  await expect(app.enabled("label:Go back")).toBe(true);
  await expect(app.enabled("label:Go forward")).toBe(false);
  await app.press("label:Go back");
  await app.waitFor("label:Settings");
  await expect(app.texts()).not.toContain("Connect an environment to see limits.");
  await expect(app.enabled("label:Go back")).toBe(false);
  await expect(app.enabled("label:Go forward")).toBe(true);
  await app.press("label:Go forward");
  await app.waitFor("text:Connect an environment to see limits.");
  await expect(app.enabled("label:Go forward")).toBe(false);
});

test("a new page after going back drops what was ahead", async () => {
  const app = await open("../../App.tsx", options);
  await app.press("label:Usage");
  await app.press("label:Go back");
  await app.waitFor("label:Settings");
  await app.press("label:Settings");
  await expect(app.enabled("label:Go forward")).toBe(false);
  await expect(app.enabled("label:Go back")).toBe(true);
});
