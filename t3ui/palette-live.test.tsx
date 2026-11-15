// The palette in the full app on server-shaped data: a project, eight threads and providers pushed through the
// store's real ingestion hooks, with an open server thread (the state a live window is in, unlike an empty app).
import { expect, open, test } from "nsh/test";

const PALETTE_INPUT = "label:Search commands, projects, and threads";

for (const [label, fixture] of [["disconnected", "./PaletteLiveFixture.tsx"], ["connected", "./PaletteLiveConnectedFixture.tsx"]] as const) {
test(`${label}: the root list shows Actions and Recent Threads for live data`, async () => {
  const app = await open(fixture, { width: 1280, height: 800 });
  await app.keyboard.press("mod+k");
  await app.waitFor("text:Actions");
  await expect(app.texts()).toContain("New thread without a project");
  await expect(app.texts()).toContain("Open settings");
  await expect(app.texts()).toContain("Recent Threads");
  await expect(app.shows("text:Live thread 1")).toBe(true);
});

test(`${label}: typing sett lists the settings action and the Settings matches`, async () => {
  const app = await open(fixture, { width: 1280, height: 800 });
  await app.keyboard.press("mod+k");
  await app.waitFor("text:Actions");
  for (const key of ["s", "e", "t", "t"]) await app.keyboard.press(key);
  await expect(app.value(PALETTE_INPUT)).toBe("sett");
  await app.waitFor("text:Open settings");
  await expect(app.texts()).toContain("Settings");
  await expect(app.texts()).toContain("Project settings");
  await expect(app.texts()).not.toContain("No matching commands, projects, or threads.");
});
}
