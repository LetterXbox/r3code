// Escape through the full app closes the innermost thing first: a menu or popover, then a dialog, then the palette, the settings or usage page, and only
// then the composer's own Escape (it dismisses its slash menu).
import { expect, open, test } from "nsh/test";

type App = Awaited<ReturnType<typeof open>>;
const settingsOpen = (app: App) => app.texts().includes("Sharing & access");
const paletteOpen = (app: App) => app.texts().includes("Navigate");
const slashMenuOpen = (app: App) => app.texts().includes("/model");
const popupOpen = (app: App) => app.texts().includes("Sound only");
const dialogOpen = (app: App) => app.texts().includes("Pair another environment to this client.");

async function until(app: App, what: string, condition: () => boolean) {
  try { await app.waitUntil(condition, { timeout: 3000 }); } catch { throw new Error(`never happened: ${what}`); }
}

async function escape(app: App, what: string, settled: () => boolean) {
  await app.keyboard.press("escape");
  await until(app, what, settled);
}

test("Escape closes a select's list, then the palette, then a dialog, then the settings page they sit over", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.keyboard.press("mod+shift+n");
  await app.keyboard.press("mod+,");
  await until(app, "settings open", () => settingsOpen(app));

  // A select's list is the innermost thing: settings stays.
  await app.press("label:Thread notifications = off");
  await until(app, "select list open", () => popupOpen(app));
  await escape(app, "select list closed by Escape", () => !popupOpen(app));
  await expect(settingsOpen(app)).toBe(true);

  // The palette over the settings page closes before it.
  await app.keyboard.press("mod+k");
  await until(app, "palette open", () => paletteOpen(app));
  await escape(app, "palette closed by Escape", () => !paletteOpen(app));
  await expect(settingsOpen(app)).toBe(true);

  // A dialog over the settings page closes before it.
  await app.press("text:Environments");
  await app.press("label:Add environment");
  await until(app, "dialog open", () => dialogOpen(app));
  await escape(app, "dialog closed by Escape", () => !dialogOpen(app));
  await expect(settingsOpen(app)).toBe(true);

  // The page itself goes last of the overlays.
  await escape(app, "settings closed by Escape", () => !settingsOpen(app));
  await expect(paletteOpen(app)).toBe(false);
  await expect(dialogOpen(app)).toBe(false);
});

test("Escape closes the usage page before the composer's slash menu, and a palette over usage before the page", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.keyboard.press("mod+shift+n");
  await app.type("id:composer-prompt", "/");
  await until(app, "slash menu open", () => slashMenuOpen(app));
  await app.keyboard.press("mod+u");
  await until(app, "usage open", () => app.texts().includes("Usage"));
  await app.keyboard.press("mod+k");
  await until(app, "palette open", () => paletteOpen(app));
  await escape(app, "palette closed by Escape", () => !paletteOpen(app));
  await expect(app.texts()).toContain("Usage");
  await escape(app, "usage closed by Escape", () => !app.texts().includes("Usage"));
  await expect(slashMenuOpen(app)).toBe(true);
  await escape(app, "slash menu dismissed by Escape", () => !slashMenuOpen(app));
});
