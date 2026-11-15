import { expect, test } from "nsh/test";
import {
  copyIdentity, customThemeCard, customThemes, installCustomTheme, normalizeHex, parseThemeFile, removeCustomThemes, resetCustomThemes,
  serializeThemeFile, themeFromCard, themeIdFromName, updateCustomTheme,
} from "./customThemes";
import { THEME_CARDS } from "../../themePreviews";
import { THEME_COLOR_ROLES } from "./themePalette";

const file = { version: 1, name: "Dusk", appearance: "dark", colors: { canvas: "#101020", accent: "#ff8800" } };

test("a theme file parses with the web's rules and round-trips", () => {
  const theme = parseThemeFile(file);
  // parseThemeFile fills the roles a file leaves out from T3 Chat's palette (getDefaultThemeColors), as the web does.
  expect(theme).toMatchObject({ id: "dusk", label: "Dusk", appearance: "dark", colors: { canvas: "#101020", accent: "#ff8800", sidebar: "#171018" } });
  expect(Object.keys(theme.colors)).toHaveLength(THEME_COLOR_ROLES.length);
  expect(parseThemeFile(JSON.parse(serializeThemeFile(theme)))).toEqual(theme);
  // Colours may be any literal CSS colour, stored as hex; unknown roles are refused.
  expect(parseThemeFile({ ...file, colors: { canvas: "oklch(0.2 0 0)", accent: "rgb(255 136 0)" } }).colors.accent).toBe("#ff8800");
  expect(() => parseThemeFile({ ...file, colors: { sidebarz: "#fff" } })).toThrow('"sidebarz" is not a supported theme color role.');
  expect(() => parseThemeFile({ ...file, colors: {} })).toThrow("Add at least one color role to the theme file.");
  expect(() => parseThemeFile("nope")).toThrow("Theme files must contain a JSON object.");
  expect(() => parseThemeFile({ ...file, version: 2 })).toThrow("unsupported version");
  expect(() => parseThemeFile({ ...file, name: "" })).toThrow("need a name");
  expect(() => parseThemeFile({ ...file, appearance: "sepia" })).toThrow('"light" or "dark"');
  expect(() => parseThemeFile({ ...file, id: "Bad Id" })).toThrow("lowercase letters");
  expect(() => parseThemeFile({ ...file, id: "default" })).toThrow('"default" is reserved');
  expect(() => parseThemeFile({ ...file, colors: { canvas: "not-a-color" } })).toThrow("must be a literal CSS color");
});

test("ids come from names and copies never collide", () => {
  expect(themeIdFromName("  My Theme! ")).toBe("my-theme");
  // Names without ASCII letters or digits get a stable hashed id (themeIdFromName), only an empty one is "custom-theme".
  expect(themeIdFromName("???")).toMatch(/^theme-[a-z0-9]+$/);
  expect(themeIdFromName("???")).toBe(themeIdFromName("???"));
  expect(themeIdFromName("  ")).toBe("custom-theme");
  expect(copyIdentity("Ocean", ["ocean-copy"])).toEqual({ id: "ocean-copy-2", label: "Ocean copy 2" });
  expect(normalizeHex("ABCDEF")).toBe("#abcdef");
  expect(normalizeHex("#12")).toBeNull();
});

test("the library installs, updates and removes themes and refuses duplicates", () => {
  resetCustomThemes();
  const dusk = parseThemeFile(file);
  installCustomTheme(dusk);
  expect(() => installCustomTheme(dusk)).toThrow('A theme named "Dusk" is already installed.');
  updateCustomTheme({ ...dusk, colors: { ...dusk.colors, accent: "#00ff00" } });
  expect(customThemes()[0]!.colors.accent).toBe("#00ff00");
  removeCustomThemes(["dusk"]);
  expect(customThemes()).toEqual([]);
});

test("a custom card draws its own palette, one preview per appearance it has", () => {
  const card = customThemeCard(parseThemeFile(file));
  expect(card.previews).toHaveLength(1);
  expect(card.previews[0]!.colors.canvas).toBe("#101020");
  // The roles the file left out are T3 Chat's, the web's default for a theme file.
  expect(card.previews[0]!.colors.sidebar).toBe("#171018");
  const both = customThemeCard(parseThemeFile({ ...file, appearance: "light", variants: { dark: { canvas: "#050607" } } }));
  expect(both.previews.map((preview) => [preview.mode, preview.colors.canvas])).toEqual([["light", "#101020"], ["dark", "#050607"]]);
  const copy = themeFromCard(THEME_CARDS[0]!, "dark", []);
  expect(copy.label).toBe("R3 Code copy");
  expect(copy.appearance).toBe("dark");
  // A copy carries every role of the standard palette, not just the seven its card draws.
  expect(Object.keys(copy.colors)).toHaveLength(THEME_COLOR_ROLES.length);
  expect(copy.colors.canvas).toBe("#000000");
});
