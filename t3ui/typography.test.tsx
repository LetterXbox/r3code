import { expect, open, test } from "nsh/test";
import { clampFontSize, cssFontFamilies, FONT_DEFAULTS } from "./typography";

test("family lists are quoted the way the web writes them and sizes stay in range", () => {
  expect(cssFontFamilies("")).toBe(null);
  expect(cssFontFamilies("Fira Code")).toBe('"Fira Code"');
  expect(cssFontFamilies("Menlo, SF Mono")).toBe('Menlo, "SF Mono"');
  expect(clampFontSize("interface", 99)).toBe(20);
  expect(clampFontSize("terminal", 1)).toBe(8);
  expect(clampFontSize("code", "x")).toBe(FONT_DEFAULTS.code);
});

test("Typography shows the simple rows, folds Advanced, and the separate fonts switch adds the four rows", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 1000 });
  await app.keyboard.press("mod+,");
  await app.press("text:Appearance");
  for (const text of ["Typography", "Interface font", "Monospace font", "Word wrap", "Advanced"]) await expect(app.texts()).toContain(text);
  await expect(app.texts()).not.toContain("Prompt font");
  await app.press("label:Advanced");
  await expect(app.texts()).toContain("Separate fonts");
  await app.press("label:Separate fonts");
  for (const text of ["Prompt font", "Code font", "Terminal font"]) await expect(app.texts()).toContain(text);
});

test("a saved interface size and family reach the shell's text", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 1000 });
  await app.keyboard.press("mod+,");
  await app.press("text:Appearance");
  await app.type("label:Interface font family", "Menlo");
  await app.keyboard.press("enter");
  await app.waitUntil(() => app.storage().settings?.includes('"fontFamilySans":"Menlo"') === true);
});
