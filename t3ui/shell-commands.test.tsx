// DEFAULT_KEYBINDINGS commands the shell registers, through the full app: the file and content search chords, appearance.cycle and
// themeEditor.toggle, and chat.new with several projects.
import { expect, open, test } from "nsh/test";

type App = Awaited<ReturnType<typeof open>>;
const paletteOpen = (app: App) => app.texts().includes("Navigate");

test("mod+p opens the file search and pressing it again closes the palette; Escape leaves a child search for the command list first", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.keyboard.press("mod+p");
  // ProjectFilePicker.tsx EmptyProjectFilePicker: with no project open (nothing is connected here) there is nothing to search.
  await app.waitFor("text:Open a project to search its files.");
  await app.keyboard.press("mod+p");
  await app.waitUntil(() => !paletteOpen(app));
  await app.keyboard.press("mod+shift+f");
  // ProjectContentSearchDialog.tsx EmptyContentSearchDialog: no project target, so the same empty state (its offline error
  // only shows for an open project).
  await app.waitFor("text:Open a project to search its files.");
  await app.keyboard.press("escape");
  await app.waitFor("text:Actions");
  await expect(paletteOpen(app)).toBe(true);
  await app.keyboard.press("escape");
  await app.waitUntil(() => !paletteOpen(app));
});

test("mod+alt+shift+a cycles the appearance and a toast names the new mode, replacing the last one", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.keyboard.press("mod+alt+shift+a");
  await app.waitFor("text:Appearance: Light");
  await app.keyboard.press("mod+alt+shift+a");
  await app.waitFor("text:Appearance: Dark");
  await expect(app.texts()).not.toContain("Appearance: Light");
  await app.keyboard.press("mod+alt+shift+a");
  await app.waitFor("text:Appearance: System");
});

test("mod+alt+shift+t opens the theme editor on the Appearance page", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.keyboard.press("mod+alt+shift+t");
  await app.waitFor("text:Sharing & access");
  await app.waitFor("text:My theme");
});

test("chat.new with several projects asks which one in the New thread in view", async () => {
  const app = await open("./ChatNewFixture.tsx", { width: 1280, height: 800, platform: "macos" });
  await app.keyboard.press("mod+n");
  await app.waitFor("text:Projects");
  await expect(app.texts()).toContain("alpha");
  await expect(app.texts()).toContain("beta");
  await expect(app.texts()).not.toContain("Sources");
  await app.press("text:beta");
  await app.waitUntil(() => !paletteOpen(app));
  await expect(app.texts()).toContain("New thread");
});

test("every command the shell owns has a handler as soon as the app is up", async () => {
  const app = await open("./CommandCoverageFixture.tsx", { width: 800, height: 600, platform: "macos" });
  const lines = app.texts().filter((text) => /: (yes|no)$/.test(text));
  expect(lines.length).toBe(18);
  expect(lines.filter((line) => line.endsWith(": no"))).toEqual([]);
});
