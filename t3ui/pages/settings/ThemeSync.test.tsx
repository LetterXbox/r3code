import { expect, open, test } from "nsh/test";

const SIZE = { width: 1000, height: 1400 };
const request = (app: Awaited<ReturnType<typeof open>>) => JSON.parse(app.storage()["theme-request"] ?? "null");

test("the theme shown as selected is the one the bundle was built with", async () => {
  const app = await open("./ThemeSyncFixture.tsx", SIZE);
  await expect(app.texts()).toContain("built grove ember");
  await expect(app.shows("id:Theme card grove (active)")).toBe(true);
  await expect(app.shows("id:Theme card ember (active)")).toBe(true);
  await expect(app.shows("id:Theme card ocean (inactive)")).toBe(true);
  await expect(app.shows("id:Grove light (picked)")).toBe(true);
  await expect(app.shows("id:Ember dark (picked)")).toBe(true);
  // Nothing is asked for while the settings agree with the build.
  await expect(app.storage()["theme-request"]).toBe(undefined);
});

test("picking a theme for dark writes a request without inserting a status row", async () => {
  const app = await open("./ThemeSyncFixture.tsx", SIZE);
  await app.press("label:Use Ocean dark mode");
  await app.waitUntil(() => app.storage()["theme-request"] !== undefined);
  const body = request(app);
  expect(body).toMatchObject({ version: 1, themeLight: "grove", themeDark: "ocean", contrast: 120, customThemes: [] });
  expect(typeof body.requestId).toBe("string");
  await expect(app.texts()).not.toContain("Applying theme...");
  await expect(app.shows("id:Applying theme")).toBe(false);
  // The selected theme stays the built one until the window is rebuilt.
  await expect(app.shows("id:Ember dark (picked)")).toBe(true);
});

test("a theme for both modes carries the custom theme it uses", async () => {
  const app = await open("./ThemeSyncFixture.tsx", SIZE);
  await app.press("label:Use Midnight theme");
  await app.waitUntil(() => app.storage()["theme-request"] !== undefined);
  expect(request(app)).toMatchObject({
    themeDark: "midnight",
    customThemes: [{ id: "midnight", label: "Midnight", appearance: "dark", colors: { canvas: "#010203" } }],
  });
});

test("contrast changes are debounced into one request", async () => {
  const app = await open("./ThemeSyncFixture.tsx", SIZE);
  await app.press("label:Contrast sweep");
  await app.waitUntil(() => app.storage()["theme-request"] !== undefined);
  await app.wait(500);
  expect(request(app).contrast).toBe(140);
  expect(app.storage()["theme-request-count"]).toBe("1");
});

test("a failed build keeps the selected theme and reports that it was not applied", async () => {
  const app = await open("./ThemeSyncFixture.tsx", SIZE);
  await app.press("label:Use Iris dark mode");
  await app.waitUntil(() => app.texts().includes("Could not apply theme"));
  await expect(app.texts()).toContain("The UI did not build with that theme.");
  await app.waitUntil(() => !app.texts().includes("Applying theme..."));
  await expect(app.shows("id:Ember dark (picked)")).toBe(true);
  await expect(app.texts()).toContain("built grove ember");
  await app.waitUntil(() => app.storage().settings?.includes('"themeDark":"iris"') === true);
  // A failed request does not loop; a later explicit choice can retry it.
  await app.wait(300);
  expect(app.storage()["theme-request-count"]).toBe("1");
});
