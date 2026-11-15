// Opening the palette in the full app: the rows are listed at once and typing lands in the palette, not the composer.
import { expect, open, test } from "nsh/test";

const PALETTE_INPUT = "label:Search commands, projects, and threads";

test("mod+k lists Actions immediately and visibly", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+k");
  await expect(app.texts()).toContain("Actions");
  await expect(app.shows("text:Open settings")).toBe(true);
  await expect(app.shows("text:New thread without a project")).toBe(true);
});

test("typed keys land in the palette input and not the composer behind it", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+shift+n");
  await expect(app.shows("id:composer-prompt")).toBe(true);
  await app.keyboard.press("mod+k");
  await app.keyboard.press("u");
  await app.keyboard.press("s");
  await expect(app.value(PALETTE_INPUT)).toBe("us");
  await expect(app.value("id:composer-prompt")).toBe("");
});

test("typing still reaches the palette field after a row opens a sub-mode", async () => {
  for (const row of ["Change appearance", "Change theme", "Go to file", "Search project contents"]) {
    const app = await open("./PaletteHarness.tsx", { width: 1280, height: 800 });
    await app.keyboard.press("mod+k");
    await app.press(`text:${row}`);
    await app.keyboard.press("a");
    await app.keyboard.press("b");
    await expect(app.value(PALETTE_INPUT)).toBe("ab");
  }
});

test("the sidebar's Add project button opens the palette's Add project view", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.press("label:Add project");
  await expect(app.texts()).toContain("Back");
  await app.keyboard.press("x");
  await expect(app.value(PALETTE_INPUT)).toBe("x");
});
