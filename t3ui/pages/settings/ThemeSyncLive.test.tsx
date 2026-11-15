import { expect, open, test } from "nsh/test";

const SIZE = { width: 1000, height: 1400 };
const liveRequest = (app: Awaited<ReturnType<typeof open>>) => JSON.parse(app.storage()["theme-live-request"] ?? "null");

test("a capable host applies a theme live: no rebuild request, one host.call, selection updates, no restart toast", async () => {
  const app = await open("./ThemeSyncLiveFixture.tsx", SIZE);
  await app.press("label:Use Ocean dark mode");
  await app.wait(2000);
  const body = liveRequest(app);
  expect(body).toMatchObject({ version: 1, themeLight: "grove", themeDark: "ocean", contrast: 120 });
  // The slow rebuild path's own request file is never written while live capable.
  expect(app.storage()["theme-request"]).toBe(undefined);
  expect(app.storage()["host-call-count"]).toBe("1");
  expect(app.storage()["host-call-name"]).toBe("theme.setOverrides");
  const sent = JSON.parse(app.storage()["host-call-data"] ?? "null");
  expect(sent).toMatchObject({ cssVars: { dark: { background: "built-ocean" } } });
  // The selection follows the live apply at once, with no window restart: the picked card is active.
  await expect(app.shows("id:Theme card ocean (active)")).toBe(true);
  await expect(app.texts()).not.toContain("Applying theme...");
  // Persisted for the next launch's themed first build, without touching the rebuild watcher's file.
  expect(JSON.parse(app.storage()["theme-last"] ?? "null")).toMatchObject({ themeDark: "ocean" });
});

test("a host that rejects the theme keeps the selection and reports the failure without a rebuild", async () => {
  const app = await open("./ThemeSyncLiveFixture.tsx", SIZE);
  await app.press("label:Use Iris dark mode");
  await app.waitUntil(() => app.texts().includes("Could not apply theme"));
  await expect(app.texts()).toContain("The host rejected that theme.");
  await app.waitUntil(() => !app.texts().includes("Applying theme..."));
  await expect(app.shows("id:Ember dark (picked)")).toBe(true);
  await expect(app.texts()).toContain("built grove ember");
  await app.waitUntil(() => app.storage().settings?.includes('"themeDark":"iris"') === true);
  expect(app.storage()["theme-request"]).toBe(undefined);
});

test("rapid changes leave the latest theme painted even when an earlier host call is slow", async () => {
  const app = await open("./ThemeSyncLiveFixture.tsx", SIZE);
  await app.press("label:Use Ocean dark mode");
  await app.waitUntil(() => app.storage()["host-started"] === "built-ocean");
  await app.press("label:Use Grove dark mode");
  await app.waitUntil(() => app.storage()["host-finished"] === "built-grove");
  expect(app.storage()["host-started"]).toBe("built-grove");
  await app.waitUntil(() => app.shows("id:Grove dark (picked)"));
  await app.waitUntil(() => JSON.parse(app.storage()["theme-last"] ?? "null")?.themeDark === "grove");
});

test("the theme editor previews a draft without saving it and restores the selected theme on cancel", async () => {
  const app = await open("./ThemeSyncLiveFixture.tsx", SIZE);
  await app.press("label:Create theme");
  await app.waitUntil(() => liveRequest(app)?.customThemes?.some((theme: { id: string }) => theme.id.startsWith("r3-editor-preview")) === true);
  const preview = liveRequest(app);
  const draft = preview.customThemes.find((theme: { id: string }) => theme.id.startsWith("r3-editor-preview"));
  expect(draft.label).toBe("Editor preview");
  await app.waitUntil(() => app.storage()["host-finished"]?.includes("r3-editor-preview") === true);
  await app.clear("label:Accent hex value");
  await app.type("label:Accent hex value", "#123456");
  await app.wait(700);
  expect(liveRequest(app)?.customThemes?.find((theme: { id: string }) => theme.id.startsWith("r3-editor-preview"))?.colors?.accent).toBe("#123456");
  expect(app.storage()["theme-last"]).toBe(undefined);
  await app.press("label:Cancel theme editor");
  await app.waitUntil(() => app.storage()["host-finished"] === "built-ember");
  expect(liveRequest(app)).toMatchObject({ themeLight: "grove", themeDark: "ember" });
});
