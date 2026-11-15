// The cases of apps/web/src/vscodeThemeImport.test.ts, against the port (hex colours instead of oklch strings).
import { expect, test } from "nsh/test";
import { isVsCodeThemeFile, pairVsCodeThemes, parseJsonc, parseThemeImport, parseVsCodeThemeFile, resolveThemeLabelCollisions } from "./vscodeThemeImport";
import { parseThemeFile, THEME_FILE_VERSION } from "./themeFile";
import { getThemeColorsForMode, parseThemeColor, themeColorToHex } from "./themePalette";

function asHex(value: string): string {
  const hex = themeColorToHex(value);
  if (!hex) throw new Error(`Expected a theme color, received ${value}`);
  return hex;
}

function contrastRatio(first: string, second: string): number {
  const toChannels = (value: string) => {
    const hex = asHex(value).slice(1);
    return [0, 1, 2].map((channel) => Number.parseInt(hex.slice(channel * 2, channel * 2 + 2), 16) / 255);
  };
  const luminance = (value: string) =>
    toChannels(value).map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

const oklchParts = (value: string) => {
  const parsed = parseThemeColor(value)!;
  return { chroma: parsed.color.C, hue: parsed.color.h };
};

const VSCODE_DARK = {
  name: "pierre-dark-soft",
  type: "dark",
  colors: {
    "editor.background": "#171717", "editor.foreground": "#d4d4d4", foreground: "#d4d4d4", "sideBar.background": "#101010",
    "sideBar.foreground": "#8a8a8a", "sideBar.border": "#1d1d1d", focusBorder: "#69b1ff", "button.background": "#69b1ff",
    "button.foreground": "#171717", "input.border": "#2c2c2c", "input.placeholderForeground": "#525252", "terminal.background": "#101010",
    "terminal.foreground": "#8a8a8a", "list.hoverBackground": "#1f3e5e59", "list.activeSelectionBackground": "#1f3e5e99",
  },
  tokenColors: [],
};

test("ordinary VS Code JSON converts the same through the import text path", () => {
  expect(parseThemeImport(JSON.stringify(VSCODE_DARK))).toEqual(parseVsCodeThemeFile(VSCODE_DARK));
});

test("VS Code JSONC (comments, trailing commas) imports without changing conversion", () => {
  for (const source of [
    '{ // line comment\n "name": "Test", "colors": { "editor.background": "#002b36" } }',
    '{ /* block comment */ "name": "Test", "colors": { "editor.background": "#002b36" } }',
    '{ "name": "Test", "colors": { "editor.background": "#002b36", }, "tokenColors": [ { "scope": ["comment",], "settings": {}, }, ], }',
  ]) {
    const theme = parseThemeImport(source);
    expect(theme.label).toBe("Test");
    expect(theme.appearance).toBe("dark");
    expect(asHex(theme.colors.canvas)).toBe("#002b36");
  }
});

test("malformed input is rejected rather than recovered from", () => {
  for (const source of [
    "",
    '{ "name": "Test", "colors": { "editor.background": "#002b36" }',
    '{ "name": "Test" "colors": { "editor.background": "#002b36" } }',
    '{ "name": "Test", "colors": { "editor.background": "#002b36" } } /* unterminated',
    '{ "name": "Test", "colors": { "editor.background": "#002b36" } } extra',
  ]) expect(() => parseThemeImport(source)).toThrow("That theme file is not valid JSON.");
  // A comma or a comment inside a string is not syntax.
  expect(parseJsonc('{"a": "x, // y /* z */ ,}"}')).toEqual({ a: "x, // y /* z */ ,}" });
});

test("native T3 theme files keep strict parsing and validation", () => {
  const nativeTheme = { version: THEME_FILE_VERSION, name: "Native theme", appearance: "dark", colors: { canvas: "#002b36" } };
  const source = JSON.stringify(nativeTheme);
  expect(parseThemeImport(source)).toEqual(parseThemeFile(nativeTheme));
  expect(() => parseThemeImport(source.replace("{", "{ /* native theme */"))).toThrow();
  expect(() => parseThemeImport(`${source.slice(0, -1)},}`)).toThrow();
  expect(() => parseThemeImport('{ /* not a theme */ "colors": { "editor.foreground": "#fff" } }')).toThrow('no "editor.background"');
  expect(() => parseThemeImport('{ "version": 1, "name": "Bad native", "appearance": "dark", "colors": { "unknown": "#fff" } }')).toThrow('"unknown" is not a supported theme color role.');
});

test("workbench themes are recognised and our own files are not", () => {
  expect(isVsCodeThemeFile(VSCODE_DARK)).toBe(true);
  expect(isVsCodeThemeFile({ type: "dark", tokenColors: [] })).toBe(true);
  expect(isVsCodeThemeFile({ version: THEME_FILE_VERSION, name: "Aurora", appearance: "light", colors: { canvas: "#ffffff" } })).toBe(false);
  expect(isVsCodeThemeFile("nope")).toBe(false);
});

test("the editor surfaces and accent carry across", () => {
  const theme = parseVsCodeThemeFile(VSCODE_DARK);
  expect(theme.label).toBe("Pierre Dark Soft");
  expect(theme.appearance).toBe("dark");
  expect(asHex(theme.colors.canvas)).toBe("#171717");
  expect(asHex(theme.colors.text)).toBe("#d4d4d4");
  expect(asHex(theme.colors.accent)).toBe("#69b1ff");
  expect(asHex(theme.colors.sidebar)).toBe("#101010");
  expect(asHex(theme.colors.terminalBackground)).toBe("#101010");
});

test("a fallback placeholder stays dimmer than entered text but readable", () => {
  const theme = parseVsCodeThemeFile({ name: "Dark placeholder fallback", type: "dark", colors: { "editor.background": "#1e1e2e", "editor.foreground": "#cdd6f4", "input.placeholderForeground": "#cdd6f473" } });
  expect(contrastRatio(theme.colors.placeholder, theme.colors.surfaceRaised)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(theme.colors.placeholder, theme.colors.canvas)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(theme.colors.placeholder, theme.colors.canvas)).toBeLessThan(contrastRatio(theme.colors.text, theme.colors.canvas));
});

test("a reserved VS Code name moves to a non-reserved id, and Dark+ and Light+ stay separate", () => {
  const darkPlus = parseVsCodeThemeFile({ name: "Dark+", type: "dark", colors: { "editor.background": "#1e1e1e" } });
  expect(darkPlus.label).toBe("Dark+");
  expect(darkPlus.id).toBe("dark-vscode");
  const themes = pairVsCodeThemes([
    parseVsCodeThemeFile({ name: "Light+", type: "light", colors: { "editor.background": "#ffffff" } }),
    darkPlus,
  ]);
  expect(themes.map((theme) => [theme.id, theme.label])).toEqual([["light-vscode", "Light+"], ["dark-vscode", "Dark+"]]);
});

test("input, focus and action colours skip transparent and indistinct candidates", () => {
  const catppuccin = parseVsCodeThemeFile({ name: "Catppuccin Mocha", type: "dark", colors: { "editor.background": "#1e1e2e", "input.border": "#00000000", "input.background": "#313244" } });
  expect(asHex(catppuccin.colors.input)).toBe("#313244");
  const gruvbox = parseVsCodeThemeFile({ name: "Gruvbox Light Soft", type: "light", colors: { "editor.background": "#f2e5bc", "button.background": "#45858880", "input.background": "#45858880", "input.border": "#928374" } });
  expect(contrastRatio(gruvbox.colors.input, gruvbox.colors.messageAction)).toBeGreaterThanOrEqual(1.1);
  const vitesse = parseVsCodeThemeFile({ name: "Vitesse Dark", type: "dark", colors: { "editor.background": "#121212", focusBorder: "#00000000", "button.background": "#4d9375" } });
  expect(asHex(vitesse.colors.accent)).toBe("#4d9375");
  expect(asHex(vitesse.colors.focus)).toBe("#4d9375");
  const raised = parseVsCodeThemeFile({ name: "Raised focus", type: "dark", colors: { "editor.background": "#000000", focusBorder: "#111111", "editorWidget.background": "#111111", "button.background": "#4d9375" } });
  expect(contrastRatio(raised.colors.focus, raised.colors.surfaceRaised)).toBeGreaterThanOrEqual(1.1);
  const button = parseVsCodeThemeFile({ name: "Transparent button", type: "dark", colors: { "editor.background": "#121212", focusBorder: "#4d9375", "button.background": "#00000000" } });
  expect(asHex(button.colors.messageAction)).toBe("#4d9375");
});

test("find backgrounds composite onto the canvas and foregrounds onto their match", () => {
  const { colors } = parseVsCodeThemeFile({
    type: "dark",
    colors: { "editor.background": "#202020", "editor.findMatchBackground": "#33669980", "editor.findMatchForeground": "#ffffffcc", "editor.findMatchHighlightBackground": "#ffcc0040", "editor.findMatchHighlightForeground": "#ffffff" },
  });
  expect(asHex(colors.searchMatchActiveBackground)).toBe("#2a435d");
  expect(asHex(colors.searchMatchActiveForeground)).toBe("#d4d9df");
  expect(asHex(colors.searchMatchBackground)).toBe("#584b18");
  expect(asHex(colors.searchMatchForeground)).toBe("#ffffff");
});

test("missing, invalid and unreadable find colours stay readable in light and dark themes", () => {
  for (const type of ["light", "dark"]) {
    const base = { "editor.background": type === "dark" ? "#101010" : "#fafafa" };
    const missing = parseVsCodeThemeFile({ type, colors: base }).colors;
    const invalid = parseVsCodeThemeFile({ type, colors: { ...base, "editor.findMatchBackground": "not-a-colour", "editor.findMatchForeground": 42, "editor.findMatchHighlightBackground": null, "editor.findMatchHighlightForeground": "invalid" } }).colors;
    const unreadable = parseVsCodeThemeFile({ type, colors: { ...base, "editor.findMatchBackground": "#ffffcc", "editor.findMatchForeground": "#ffffff", "editor.findMatchHighlightBackground": "#101020", "editor.findMatchHighlightForeground": "#111111" } }).colors;
    for (const colors of [missing, invalid, unreadable]) {
      expect(contrastRatio(colors.searchMatchForeground, colors.searchMatchBackground)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.searchMatchActiveForeground, colors.searchMatchActiveBackground)).toBeGreaterThanOrEqual(4.5);
    }
    expect(invalid.searchMatchBackground).toBe(missing.searchMatchBackground);
    expect(invalid.searchMatchActiveBackground).toBe(missing.searchMatchActiveBackground);
    expect(missing.searchMatchBackground).not.toBe(missing.searchMatchActiveBackground);
    expect(missing.searchMatchBackground).not.toBe(missing.canvas);
  }
});

test("every role the file omits is filled with a readable derived value", () => {
  const theme = parseVsCodeThemeFile(VSCODE_DARK);
  const colors = getThemeColorsForMode(theme, "dark")!;
  for (const value of Object.values(colors)) expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
  expect(contrastRatio(colors.text, colors.canvas)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(colors.sidebarForeground, colors.sidebar)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(colors.messageActionForeground, colors.messageAction)).toBeGreaterThanOrEqual(4.5);
});

test("the appearance falls back to the editor background when the type is missing or odd", () => {
  expect(parseVsCodeThemeFile({ name: "Untyped", colors: { "editor.background": "#fdfdfd", "editor.foreground": "#202020" } }).appearance).toBe("light");
  expect(parseVsCodeThemeFile({ name: "High contrast", type: "hc-light", colors: { "editor.background": "#ffffff" } }).appearance).toBe("light");
});

test("a dim status colour keeps its hue on dark and light canvases", () => {
  for (const [type, canvas] of [["dark", "#282828"], ["light", "#ffffff"]] as const) {
    const theme = parseVsCodeThemeFile({ name: "Gruvbox", type, colors: { "editor.background": canvas, "editorError.foreground": "#fb4934", "editorWarning.foreground": "#b57614" } });
    for (const [role, source] of [["error", "#fb4934"], ["warning", "#b57614"]] as const) {
      const imported = oklchParts(theme.colors[role]);
      expect(contrastRatio(theme.colors[role], theme.colors.canvas)).toBeGreaterThanOrEqual(4.5);
      expect(imported.chroma).toBeGreaterThan(0.1);
      expect(Math.abs(imported.hue - oklchParts(source).hue)).toBeLessThan(2);
    }
  }
  const hidden = parseVsCodeThemeFile({ name: "Hidden squiggles", type: "dark", colors: { "editor.background": "#101010", "editorError.foreground": "#ff000000" } });
  expect(oklchParts(hidden.colors.error).chroma).toBeGreaterThan(0.1);
});

test("a replaced surface keeps a readable foreground", () => {
  const theme = parseVsCodeThemeFile({ name: "Split", type: "dark", colors: { "editor.background": "#101010", "editor.foreground": "#f5f5f5", "sideBar.background": "#fafafa", "terminal.background": "#fbfbfb" } });
  expect(asHex(theme.colors.sidebar)).toBe("#fafafa");
  expect(contrastRatio(theme.colors.sidebarForeground, theme.colors.sidebar)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(theme.colors.terminalForeground, theme.colors.terminalBackground)).toBeGreaterThanOrEqual(4.5);
});

test("wide-gamut color() notation is read", () => {
  const theme = parseVsCodeThemeFile({
    name: "Vibrant", type: "dark",
    colors: {
      "editor.background": "color(display-p3 0.039216 0.039216 0.039216)", "editor.foreground": "color(display-p3 0.980392 0.980392 0.980392)",
      focusBorder: "color(display-p3 0.308664 0.645271 1.000000)", "editor.selectionBackground": "color(display-p3 0.308664 0.645271 1.000000 / 0.300000)",
    },
  });
  expect(asHex(theme.colors.canvas)).toMatch(/^#0[89ab]/);
  expect(asHex(theme.colors.text)).toMatch(/^#f[a-f0-9]/);
  const accent = asHex(theme.colors.accent);
  const [red, green, blue] = [1, 3, 5].map((index) => Number.parseInt(accent.slice(index, index + 2), 16)) as [number, number, number];
  expect(blue).toBeGreaterThan(200);
  expect(blue).toBeGreaterThan(red);
  expect(green).toBeGreaterThan(red);
});

test("a family's light and dark files pair into one dual-mode theme", () => {
  const make = (name: string, type: "light" | "dark") =>
    parseVsCodeThemeFile({ name, type, colors: { "editor.background": type === "dark" ? "#101014" : "#fdfdfd", "editor.foreground": type === "dark" ? "#e6e6e6" : "#1f1f1f", focusBorder: "#69b1ff" } });
  const themes = pairVsCodeThemes([make("github-dark", "dark"), make("github-light", "light"), make("github-dark-colorblind", "dark"), make("github-light-colorblind", "light"), make("github-dark-dimmed", "dark")]);
  expect(themes.map((theme) => theme.label)).toEqual(["Github", "Github Colorblind", "Github Dark Dimmed"]);
  const github = themes[0]!;
  expect(github.appearance).toBe("light");
  expect(getThemeColorsForMode(github, "dark")).not.toBeNull();
  expect(asHex(getThemeColorsForMode(github, "dark")!.canvas)).toBe("#101014");
  expect(asHex(github.colors.canvas)).toBe("#fdfdfd");
  expect(getThemeColorsForMode(themes[2]!, "light")).toBeNull();
});

test("an ambiguous family is not guessed", () => {
  const make = (name: string, type: "light" | "dark") => parseVsCodeThemeFile({ name, type, colors: { "editor.background": type === "dark" ? "#101014" : "#fdfdfd" } });
  const themes = pairVsCodeThemes([make("solar-dark", "dark"), make("solar-dark-soft", "dark"), make("solar-light", "light")]);
  expect(themes.map((theme) => theme.label).sort()).toEqual(["Solar", "Solar Dark Soft"]);
});

test("same-named variants are told apart by their file names, then numbered", () => {
  const dracula = (bg: string) => parseVsCodeThemeFile({ name: "Dracula", type: "dark", colors: { "editor.background": bg, "editor.foreground": "#f8f8f2" } });
  const themes = resolveThemeLabelCollisions([{ theme: dracula("#282a36"), sourceName: "dracula.json" }, { theme: dracula("#22232e"), sourceName: "dracula-soft.json" }]);
  expect(themes.map((theme) => theme.label)).toEqual(["Dracula", "Dracula Soft"]);
  expect(themes.map((theme) => theme.id)).toEqual(["dracula", "dracula-soft"]);
  const numbered = resolveThemeLabelCollisions([{ theme: dracula("#282a36") }, { theme: dracula("#22232e") }]);
  expect(numbered.map((theme) => theme.label)).toEqual(["Dracula", "Dracula 2"]);
});
