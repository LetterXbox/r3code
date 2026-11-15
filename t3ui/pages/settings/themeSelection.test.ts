import { expect, test } from "nsh/test";
import { restoreSavedSettings, settingValue, validSavedSettings } from "../../store";
import { BUILT_THEME_ID, builtThemeForMode, parseBuiltTheme, setBuiltTheme, themeRebuildAvailable } from "./builtTheme";
import { cardById, chooseTheme, pickedThemeForMode, releaseTheme, themeForMode, themeNotice, useTheme } from "./themeSelection";

test("no launcher build means Ocean at contrast 100", () => {
  expect(BUILT_THEME_ID).toBe("ocean");
  expect(themeRebuildAvailable()).toBe(false);
  expect(builtThemeForMode("light")).toBe("ocean");
  expect(themeForMode("dark")).toBe("ocean");
});

test("the launcher's description of the bundle is read, anything else is ignored", () => {
  expect(parseBuiltTheme('{"light":"grove","dark":"ember","contrast":130}')).toEqual({ light: "grove", dark: "ember", contrast: 130 });
  for (const text of [undefined, "", "{nope", "[]", '{"light":"Grove","dark":"ember","contrast":100}', '{"light":"a","dark":"b","contrast":10}', '{"light":"a","dark":"b"}']) {
    expect(parseBuiltTheme(text)).toBe(null);
  }
});

test("saved theme ids of any known theme are restored on load", () => {
  const saved = { themeLight: "grove", themeDark: "midnight-2", colorScheme: "system", wordWrap: true };
  expect(validSavedSettings(saved, {})).toEqual(saved);
  expect(validSavedSettings({ themeLight: "Not An Id", themeDark: 4 }, {})).toEqual({});
});

test("the shown theme is the built one; a pick is saved and applies after the rebuild", () => {
  restoreSavedSettings(JSON.stringify({ themeLight: "grove", themeDark: "grove", colorScheme: "dark" }));
  expect(settingValue("themeLight")).toBe("grove");
  expect(themeForMode("light")).toBe("ocean");
  chooseTheme("dark", "ember");
  expect(settingValue("themeDark")).toBe("ember");
  expect(pickedThemeForMode("dark")).toBe("ember");
  expect(themeForMode("dark")).toBe("ocean");
  useTheme(cardById("iris"));
  expect(settingValue("themeLight")).toBe("iris");
  expect(settingValue("themeDark")).toBe("iris");
  expect(themeNotice()).toBe("");
});

test("once the bundle is built in another theme, that theme is the selected one for its mode", () => {
  setBuiltTheme({ light: "grove", dark: "ember", contrast: 100 });
  try {
    expect(themeForMode("light")).toBe("grove");
    expect(themeForMode("dark")).toBe("ember");
    expect(cardById(themeForMode("dark")).label).toBe("Ember");
  } finally {
    setBuiltTheme(null);
  }
});

test("removing a theme in use puts the mode back on the default", () => {
  chooseTheme("light", "midnight");
  releaseTheme("midnight");
  expect(settingValue("themeLight")).toBe("ocean");
});
