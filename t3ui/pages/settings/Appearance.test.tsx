import { expect, open, test } from "nsh/test";

test("a saved Grove pick is not shown before it is built: Ocean is the active theme, ringed in both modes", async () => {
  const app = await open("./AppearanceFixture.tsx", { width: 1000, height: 1400 });
  await expect(app.shows("id:Theme card ocean (active)")).toBe(true);
  await expect(app.shows("id:Theme card grove (inactive)")).toBe(true);
  await expect(app.shows("id:Ocean light (picked)")).toBe(true);
  await expect(app.shows("id:Ocean dark (picked)")).toBe(true);
  await expect(app.shows("id:Grove light (unpicked)")).toBe(true);
  await expect(app.shows("id:Grove dark (unpicked)")).toBe(true);
});

test("the colour-scheme tiles carry the saved scheme, not a hardcoded one", async () => {
  const app = await open("./AppearanceFixture.tsx", { width: 1000, height: 1400 });
  await expect(app.shows("id:Appearance mode light (on)")).toBe(true);
  await expect(app.shows("id:Appearance mode system (off)")).toBe(true);
  await expect(app.shows("id:Appearance mode dark (off)")).toBe(true);
  await app.press("label:Follow the system appearance");
  await expect(app.shows("id:Appearance mode system (on)")).toBe(true);
  await expect(app.shows("id:Appearance mode light (off)")).toBe(true);
});

test("without a theme-aware build a pick is saved and Ocean stays the shown theme", async () => {
  const app = await open("./AppearanceFixture.tsx", { width: 1000, height: 1400 });
  await app.press("label:Use Ember dark mode");
  await app.waitUntil(() => app.storage().settings?.includes('"themeDark":"ember"') === true);
  await expect(app.shows("id:Ocean dark (picked)")).toBe(true);
  await expect(app.shows("id:Ember dark (unpicked)")).toBe(true);
});
