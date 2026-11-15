import { expect, open, test } from "nsh/test";

test("arrow keys select a command and Enter runs that command", async () => {
  const app = await open("./PaletteHarness.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+k");
  await app.type("label:Search commands, projects, and threads", "Open ");
  // Open pull requests waits for the server config, so Open usage leads and Down moves to Open settings.
  await app.keyboard.press("down");
  await app.keyboard.press("up");
  await app.submit("label:Search commands, projects, and threads");
  await expect(app.texts()).toContain("Usage dialog active");
  await expect(app.texts()).not.toContain("Open settings");
});

test("backspace leaves an empty submenu and Escape closes the palette", async () => {
  const app = await open("./PaletteHarness.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+k");
  await app.press("text:Change appearance");
  await expect(app.texts()).toContain("Light");
  await expect(app.texts()).toContain("Back");
  await app.keyboard.press("backspace");
  await expect(app.texts()).toContain("Change appearance");
  await expect(app.texts()).not.toContain("Light");
  await app.keyboard.press("escape");
  await expect(app.texts()).not.toContain("Change appearance");
});

test("rows show shortcut badges and the footer lists the hints", async () => {
  const app = await open("./PaletteHarness.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+k");
  await expect(app.texts()).toContain("⌘U");
  await expect(app.texts()).toContain("Navigate");
  await expect(app.texts()).toContain("Close");
  await expect(app.texts()).not.toContain("Back");
});

test("Go to file searches workspace files and picking one closes the palette", async () => {
  const app = await open("./PaletteHarness.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+k");
  await app.press("text:Go to file");
  await expect(app.texts()).toContain("Back");
  await app.type("label:Search commands, projects, and threads", "app");
  await app.waitFor("text:app.ts");
  await expect(app.texts()).toContain("src");
  await expect(app.texts()).not.toContain("docs");
  await app.press("text:app.ts");
  await expect(app.texts()).not.toContain("app.ts");
});

test("Search project contents lists matching lines with a results summary and toggles", async () => {
  // Offline, content search says "This environment is not connected." (reference); this harness grants filesystem:read.
  const app = await open("./PaletteContentHarness.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+k");
  await app.press("text:Search project contents");
  await expect(app.texts()).toContain("Aa");
  await expect(app.texts()).toContain("Type to search across your project.");
  await app.type("label:Search commands, projects, and threads", "foo");
  await app.waitFor("text:1 results in 1 files");
  await expect(app.texts()).toContain("src/app.ts:7");
});
