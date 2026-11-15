// The Usage page on a connected environment: limits come from the live provider list at once, every environment reads on its
// own, and an unreachable or slow environment never blocks the others (UsagePage's per-environment presentations).
import { expect, open, test } from "nsh/test";

test("limits show from the live provider list while the provider refresh never answers", async () => {
  const app = await open("./UsageLiveFixture.tsx", { width: 1280, height: 900 });
  await app.keyboard.press("mod+u");
  await app.waitFor("text:Weekly");
  await expect(app.texts()).toContain("41%");
  await expect(app.texts()).not.toContain("Loading limits...");
});

test("an unreachable environment is named on the limits page while the others still show", async () => {
  const app = await open("./UsageLiveFixture.tsx", { width: 1280, height: 900 });
  await app.keyboard.press("mod+u");
  await app.waitFor("text:dead.host: The environment did not respond.");
  await expect(app.texts()).toContain("41%");
});

test("a slow environment's limits join the page when they arrive, without having held the rest back", async () => {
  const app = await open("./UsageLiveFixture.tsx", { width: 1280, height: 900 });
  await app.keyboard.press("mod+u");
  await app.waitFor("text:Weekly");
  await expect(app.texts()).not.toContain("90%");
  await app.waitFor("text:90%", { timeout: 6000 });
  await expect(app.texts()).toContain("41%");
});

test("cost totals show the answering environment at once and add the slow one later", async () => {
  const app = await open("./UsageLiveFixture.tsx", { width: 1280, height: 900 });
  await app.keyboard.press("mod+u");
  await app.press("label:Cost");
  await app.waitFor("text:$3.00");
  await expect(app.shows("label:Some environments could not report usage")).toBe(true);
  await app.waitFor("text:$5.00", { timeout: 6000 });
});

test("the provider filter reads All providers when nothing is hidden", async () => {
  const app = await open("./UsageLiveFixture.tsx", { width: 1280, height: 900 });
  await app.keyboard.press("mod+u");
  await app.waitFor("label:Usage providers");
  await expect(app.texts()).toContain("All providers");
  await expect(app.texts()).not.toContain("7 providers");
});
