// Escape from the states a real window gets into: the composer's editor holding the keyboard under Settings, and a mouse press
// on a palette row. A failed run of the real window showed neither closing, so each is pressed the way a user does.
import { expect, open, test } from "nsh/test";

type App = Awaited<ReturnType<typeof open>>;
const settingsOpen = (app: App) => app.texts().includes("Sharing & access");
const paletteOpen = (app: App) => app.texts().includes("Navigate");

async function until(app: App, what: string, condition: () => boolean) {
  try { await app.waitUntil(condition, { timeout: 3000 }); } catch { throw new Error(`never happened: ${what}`); }
}

test("Escape closes Settings while the composer's editor still holds the keyboard", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.keyboard.press("mod+shift+n");
  await app.type("id:composer-prompt", "hello");
  await app.keyboard.press("mod+,");
  await until(app, "settings open", () => settingsOpen(app));
  await app.keyboard.press("escape");
  await until(app, "settings closed by Escape", () => !settingsOpen(app));
});

test("Escape closes the palette after a press on the Change theme row, and the field keeps the keyboard", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.keyboard.press("mod+k");
  await until(app, "palette open", () => paletteOpen(app));
  await app.press("text:Change theme");
  await until(app, "theme list shown", () => app.texts().includes("Ocean"));
  await app.keyboard.press("escape");
  await until(app, "palette closed by Escape", () => !paletteOpen(app));
});

test("Escape from a palette child search goes back to the command list, a second one closes", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.keyboard.press("mod+k");
  await until(app, "palette open", () => paletteOpen(app));
  await app.press("text:Go to file");
  await until(app, "file search shown", () => app.texts().includes("Search files…") || app.texts().includes("No files found.") || app.texts().includes("Indexing workspace files…") || app.texts().includes("Open a project to search its files."));
  await app.keyboard.press("escape");
  await until(app, "back on the command list", () => app.texts().includes("Change appearance"));
  await app.keyboard.press("escape");
  await until(app, "palette closed", () => !paletteOpen(app));
});
