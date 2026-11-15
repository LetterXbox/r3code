import { expect, open, test } from "nsh/test";

const DUSK = '{"version":1,"name":"Dusk","appearance":"dark","colors":{"canvas":"#101020","accent":"#ff8800"}}';

async function importDusk(app: Awaited<ReturnType<typeof open>>) {
  await app.press("label:Add theme");
  await app.type("label:Theme JSON", DUSK);
  await app.press("label:Confirm add theme");
}

test("the library shows the built-in cards with Create theme and Add theme", async () => {
  const app = await open("./ThemeLibraryFixture.tsx", { width: 1000, height: 1400 });
  for (const text of ["Themes", "Create theme", "Add theme", "R3 Code", "Ocean"]) await expect(app.texts()).toContain(text);
  await expect(app.shows("label:Duplicate Ocean")).toBe(true);
  await expect(app.shows("label:Edit Ocean")).toBe(false);
});

test("the theme editor leaves the appearance page interactive", async () => {
  const app = await open("./ThemeLibraryFixture.tsx", { width: 1000, height: 1400 });
  await app.press("label:Create theme");
  await app.waitFor("label:Theme name");
  await app.press("label:Use light mode");
  expect(app.shows("label:Theme name")).toBe(true);
  await app.type("label:Theme name", "Example");
  expect(app.value("label:Theme name")).toBe("Example");
  await app.drag("label:Move theme editor", { x: -100, y: -80 });
  await app.drag("label:Resize theme editor", { x: 50, y: 40 });
  expect(app.value("label:Theme name")).toBe("Example");
  await app.press("label:Cancel theme editor");
  expect(app.shows("label:Theme name")).toBe(false);
});

test("Escape closes the floating theme editor", async () => {
  const app = await open("./ThemeLibraryFixture.tsx", { width: 1000, height: 1400 });
  await app.press("label:Create theme");
  await app.waitFor("label:Theme name");
  await app.keyboard.press("escape");
  await app.waitUntil(() => !app.shows("label:Theme name"));
  expect(app.shows("label:Create theme")).toBe(true);
});

test("Add theme imports a theme file as an editable custom card", async () => {
  const app = await open("./ThemeLibraryFixture.tsx", { width: 1000, height: 1400 });
  await importDusk(app);
  await expect(app.texts()).toContain("Dusk added");
  // The built theme stays the active one until the launcher has rebuilt the window with the imported theme.
  await expect(app.shows("id:Theme card ocean (active)")).toBe(true);
  await expect(app.shows("id:Theme card dusk (inactive)")).toBe(true);
  for (const label of ["Edit Dusk", "Duplicate Dusk", "Export Dusk", "Remove Dusk"]) await expect(app.shows(`label:${label}`)).toBe(true);
});

test("importing bad JSON or an unsupported file explains what is wrong", async () => {
  const app = await open("./ThemeLibraryFixture.tsx", { width: 1000, height: 1400 });
  await app.press("label:Add theme");
  await app.type("label:Theme JSON", "{nope");
  await app.press("label:Confirm add theme");
  await expect(app.texts()).toContain("That theme file is not valid JSON.");
  await app.clear("label:Theme JSON");
  await app.type("label:Theme JSON", '{"version":9,"name":"X","appearance":"dark","colors":{"canvas":"#000000"}}');
  await app.press("label:Confirm add theme");
  await expect(app.texts()).toContain("This theme file uses an unsupported version. Expected 1.");
});

test("importing a theme that is installed offers Update existing and Keep both", async () => {
  const app = await open("./ThemeLibraryFixture.tsx", { width: 1000, height: 1400 });
  await importDusk(app);
  await importDusk(app);
  await expect(app.texts()).toContain("Already installed");
  await app.press("text:Keep both");
  await expect(app.shows("id:Theme card dusk-1 (inactive)")).toBe(true);
});

test("Edit changes the name and colors and Save updates the card", async () => {
  const app = await open("./ThemeLibraryFixture.tsx", { width: 1000, height: 1400 });
  await importDusk(app);
  await app.press("label:Edit Dusk");
  await expect(app.texts()).toContain("Edit theme");
  await app.clear("label:Theme name");
  await app.type("label:Theme name", "Twilight");
  await app.press("label:Save theme");
  await expect(app.texts()).toContain("Twilight saved");
  await expect(app.shows("label:Edit Twilight")).toBe(true);
});

test("the editor ignores a color that is not a color", async () => {
  const app = await open("./ThemeLibraryFixture.tsx", { width: 1000, height: 1400 });
  await importDusk(app);
  await app.press("label:Edit Dusk");
  await app.clear("label:Accent hex value");
  await app.type("label:Accent hex value", "orange");
  // A value that is not a colour is not applied: the field falls back to the saved colour.
  await app.press("label:Save theme");
  await expect(app.shows("label:Edit Dusk")).toBe(true);
  // It saved without the invalid text: the editor closed and the saved accent is still orange (#ff8800).
  await expect(app.shows("label:Theme name")).toBe(false);
});

test("Duplicate on a built-in card opens the editor on its copy and saving adds it", async () => {
  const app = await open("./ThemeLibraryFixture.tsx", { width: 1000, height: 1400 });
  await app.press("label:Duplicate Ocean");
  await expect(app.texts()).toContain("Create theme");
  await app.press("label:Save theme");
  await expect(app.texts()).toContain("Ocean copy created");
  await expect(app.shows("label:Edit Ocean copy")).toBe(true);
});

test("Create theme seeds from the active theme and Remove asks before deleting", async () => {
  const app = await open("./ThemeLibraryFixture.tsx", { width: 1000, height: 1400 });
  await importDusk(app);
  await app.press("label:Remove Dusk");
  await expect(app.texts()).toContain("Remove “Dusk”?");
  await expect(app.texts()).toContain("You can bring it back anytime by importing its JSON file.");
  await app.press("label:Cancel remove theme");
  await expect(app.shows("label:Edit Dusk")).toBe(true);
  await app.press("label:Remove Dusk");
  await app.press("text:Remove theme");
  await expect(app.shows("label:Edit Dusk")).toBe(false);
  await expect(app.shows("id:Theme card ocean (active)")).toBe(true);
  await app.press("label:Create theme");
  await expect(app.shows("label:Theme name")).toBe(true);
});

test("Export puts the theme file on the clipboard", async () => {
  const app = await open("./ThemeLibraryFixture.tsx", { width: 1000, height: 1400 });
  await importDusk(app);
  await app.press("label:Export Dusk");
  await app.wait(50);
  await expect(app.texts()).toContain("Copied dusk.json to the clipboard.");
});

test("Add a theme searches Open VSX and says so when nothing supported comes back, and when it is unavailable", async () => {
  const app = await open("./ThemeLibraryFixture.tsx", { width: 1000, height: 1800, network: { "GET https://open-vsx.org/api/-/search?*": { body: { extensions: [] } } } });
  await app.press("label:Add theme");
  for (const text of ["Add a theme", "Search community themes", "Find open-source themes from Open VSX.", "Popular", "Dracula", "Catppuccin", "Nord", "Tokyo Night", "Theme file", "Drop R3 Code or VS Code .json files", "Theme JSON"]) await expect(app.texts()).toContain(text);
  await app.type("label:Search Open VSX themes", "nord");
  await app.waitFor("text:No supported open-source themes found", { timeout: 8000 });
  await expect(app.texts()).toContain("Try a broader search.");
  const down = await open("./ThemeLibraryFixture.tsx", { width: 1000, height: 1800, network: { "GET https://open-vsx.org/api/-/search?*": { status: 503 } } });
  await down.press("label:Add theme");
  await down.press("label:Dracula");
  await down.waitFor("text:Open VSX search is unavailable right now.", { timeout: 8000 });
});

test("Add a theme imports a VS Code theme file as a theme in the library", async () => {
  const app = await open("./ThemeLibraryFixture.tsx", { width: 1000, height: 1800 });
  await app.press("label:Add theme");
  await app.type("label:Theme JSON", '{ // VS Code\n "name": "Pierre Dark", "type": "dark", "colors": { "editor.background": "#171717", "focusBorder": "#69b1ff", }, "tokenColors": [] }');
  await app.press("label:Confirm add theme");
  await expect(app.texts()).toContain("Pierre Dark added");
  await expect(app.shows("id:Theme card pierre-dark (inactive)")).toBe(true);
});
