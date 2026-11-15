import { expect, open, test } from "nsh/test";
import { themePickerColor, themePickerRgb, themePickerRgbToHex } from "./ThemeColorPicker";

test("picker preserves nonopaque alpha when changing the color", () => {
  expect(themePickerColor("#aabbcc", "#33669980")).toBe("#aabbcc80");
  expect(themePickerColor("#aabbcc", "#336699ff")).toBe("#aabbcc");
});

test("RGB accepts three integer channels and rejects invalid values", () => {
  expect(themePickerRgb("#33669980")).toBe("51, 102, 153");
  expect(themePickerRgbToHex("rgb(255, 1, 16)")).toBe("#ff0110");
  expect(themePickerRgbToHex("256, 1, 2")).toBeNull();
  expect(themePickerRgbToHex("1, 2.5, 3")).toBeNull();
});

test("the theme swatch opens its color picker", async () => {
  const app = await open("./ThemeColorPickerFixture.tsx", { width: 700, height: 600 });
  await app.press("label:Choose Background color");
  await app.waitFor("label:Background picker hex value");
  expect(app.shows("label:Background hue")).toBe(true);
});

test("changing a color previews it and Escape restores the prior value", async () => {
  const app = await open("./ThemeColorPickerFixture.tsx", { width: 700, height: 600 });
  await app.press("label:Choose Background color");
  await app.clear("label:Background picker hex value");
  await app.type("label:Background picker hex value", "#aabbcc");
  await app.submit("label:Background picker hex value");
  await app.waitFor("text:Color: #aabbcc80");
  await app.keyboard.press("escape");
  await app.waitFor("text:Color: #33669980");
});

test("RGB edits update the preview and invalid values reset without changing it", async () => {
  const app = await open("./ThemeColorPickerFixture.tsx", { width: 700, height: 600 });
  await app.press("label:Choose Background color");
  await app.waitFor("label:Background picker RGB value");
  await app.clear("label:Background picker RGB value");
  await app.type("label:Background picker RGB value", "255, 1, 16");
  await app.submit("label:Background picker RGB value");
  await app.waitFor("text:Color: #ff011080");
  await app.clear("label:Background picker RGB value");
  await app.type("label:Background picker RGB value", "bad");
  await app.submit("label:Background picker RGB value");
  expect(app.texts()).toContain("Color: #ff011080");
  expect(app.value("label:Background picker RGB value")).toBe("255, 1, 16");
});
