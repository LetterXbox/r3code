import { expect, test } from "nsh/test";
import { setColorScheme, token } from "nsh";
import { composerGlassSurface, composerHighlight, composerOutline, dropdownGlassAmount, glassOpacity, glassPopover, parseColor, tokenAlpha, tokenOver } from "./tokenColor";
import { updateSetting } from "../../store";
import { setBuiltTheme } from "../../pages/settings/builtTheme";

test("a token colour is read in every spelling the theme and the host give", () => {
  expect(parseColor("#414851ff")).toEqual([65, 72, 81]);
  expect(parseColor("#414851")).toEqual([65, 72, 81]);
  expect(parseColor("#fff")).toEqual([255, 255, 255]);
  expect(parseColor("rgb(65,72,81)")).toEqual([65, 72, 81]);
  expect(parseColor("rgba(65, 72, 81, 0.5)")).toEqual([65, 72, 81]);
  expect(parseColor("not a colour")).toBe(null);
});

test("composer uses T3's themed surface and outline for each appearance", () => {
  setBuiltTheme({ light: "ocean", dark: "ember", contrast: 100 });
  setColorScheme("light");
  expect(composerGlassSurface()).toBe(tokenAlpha("surface-raised", glassOpacity()));
  expect(composerOutline()).toBe(String(token("toolbar-border")));
  setColorScheme("dark");
  expect(composerOutline()).toBe(tokenOver("input", "background", 0.3));
  expect(composerHighlight()).toBe(tokenAlpha("input", 0.12));
  setBuiltTheme({ light: "default", dark: "t3-chat", contrast: 100 });
  expect(composerOutline()).toBe("#241e28");
  expect(composerHighlight()).toBe("rgba(67,45,72,0.12)");
  setColorScheme("light");
  expect(composerGlassSurface()).toBe(tokenAlpha("card", glassOpacity()));
  expect(composerOutline()).toBe("rgba(0,0,0,0.08)");
  setBuiltTheme(null);
  setColorScheme("system");
});

test("glass opacity maps to the dropdown-glass amount as the reference does", () => {
  expect(Math.abs(dropdownGlassAmount(0.8) - 0.836) < 0.001).toBe(true);
  expect(Math.abs(dropdownGlassAmount(1) - 1) < 0.00001).toBe(true);
  expect(dropdownGlassAmount(0.4) < dropdownGlassAmount(0.8)).toBe(true);
  expect(glassOpacity() >= 0.4 && glassOpacity() <= 1).toBe(true);
});

test("the composer and popover keep the selected transparency", () => {
  setBuiltTheme({ light: "default", dark: "default", contrast: 100 });
  setColorScheme("light");
  updateSetting("glassOpacity", 40);
  expect(composerGlassSurface().endsWith(",0.4)")).toBe(true);
  expect(glassPopover().endsWith(`,${dropdownGlassAmount(0.4)})`)).toBe(true);
  updateSetting("glassOpacity", 100);
  expect(composerGlassSurface().endsWith(",1)")).toBe(true);
  expect(glassPopover().endsWith(",1)")).toBe(true);
  updateSetting("glassOpacity", 80);
  setBuiltTheme(null);
  setColorScheme("system");
});
