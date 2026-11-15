// The menu's commands through the full app: Cmd+= / Cmd+- / Cmd+0 zoom the app when no preview has the focus and the level is saved; the
// updates item says honestly that there is no updater.
import { expect, open, test } from "nsh/test";

const options = { width: 1280, height: 800, platform: "macos" as const };
const saved = (app: Awaited<ReturnType<typeof open>>) => app.storage().app_zoom_level;

test("Cmd+= and Cmd+- zoom by half a level, Cmd+0 goes back to actual size, and the level is saved", async () => {
  const app = await open("../App.tsx", options);
  await app.keyboard.press("mod+plus");
  await app.waitUntil(() => saved(app) === "0.5");
  await app.keyboard.press("mod+plus");
  await app.waitUntil(() => saved(app) === "1");
  await app.keyboard.press("mod+minus");
  await app.waitUntil(() => saved(app) === "0.5");
  await app.keyboard.press("mod+0");
  await app.waitUntil(() => saved(app) === undefined);
});

test("Cmd+Shift+= (Cmd++ on a US keyboard) zooms in too", async () => {
  const app = await open("../App.tsx", options);
  await app.keyboard.press("mod+shift+plus");
  await app.waitUntil(() => saved(app) === "0.5");
});
