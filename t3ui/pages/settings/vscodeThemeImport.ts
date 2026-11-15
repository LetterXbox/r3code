// Turning a VS Code colour theme into a T3 theme, ported from apps/web/src/vscodeThemeImport.ts. The workbench
// colours (`colors`: editor.background, sideBar.background, focusBorder, ...) are mapped onto the theme roles
// (canvas, sidebar, accent, ...); every role the file does not name is derived from the background and accent
// (createVividThemeColors) and kept readable. Like the web, this reads only `colors`: `tokenColors` (syntax
// highlighting) are used only to recognise a VS Code file, because the app's code colours come from the code
// theme, not the UI theme. The result is a theme definition (hex colours) the generator flattens into tokens
// (tools/build_theme.py), so an imported theme goes through the same request, rebuild and report loop as the
// built-in ones.
import { isReservedThemeId, parseThemeFile, themeIdFromName, THEME_FILE_VERSION } from "./themeFile";
import {
  createVividThemeColors, getStandardThemeColors, getThemeModes, readableThemeColorOn, themeColorToHex, type ThemeAppearance, type ThemeColorRole,
  type ThemeDefinition,
} from "./themePalette";

interface Rgba { r: number; g: number; b: number; a: number }
interface Rgb { r: number; g: number; b: number }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const decodeGamma = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
const encodeGamma = (value: number) => {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
};

function parseColorFunction(value: string): Rgba | null {
  const match = /^color\(\s*(display-p3|srgb)\s+([^)]+)\)$/i.exec(value);
  if (!match) return null;
  const space = match[1]!.toLowerCase();
  const [channelPart, alphaPart] = match[2]!.split("/");
  const channels = channelPart!.trim().split(/\s+/).map((part) => (part.endsWith("%") ? Number.parseFloat(part) / 100 : Number.parseFloat(part)));
  if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) return null;
  const alphaRaw = alphaPart?.trim();
  const alpha = alphaRaw === undefined ? 1 : alphaRaw.endsWith("%") ? Number.parseFloat(alphaRaw) / 100 : Number.parseFloat(alphaRaw);
  if (!Number.isFinite(alpha)) return null;
  const [red, green, blue] = channels as [number, number, number];
  if (space === "srgb") return { r: red * 255, g: green * 255, b: blue * 255, a: Math.max(0, Math.min(1, alpha)) };
  const [lr, lg, lb] = [red, green, blue].map(decodeGamma) as [number, number, number];
  const srgb = [
    1.2249401762805 * lr - 0.2249401762805 * lg,
    -0.042056961239 * lr + 1.042056961239 * lg,
    -0.0196375547643 * lr - 0.0786360655012 * lg + 1.0982736202656 * lb,
  ].map((channel) => encodeGamma(channel) * 255) as [number, number, number];
  return { r: srgb[0], g: srgb[1], b: srgb[2], a: Math.max(0, Math.min(1, alpha)) };
}

function parseVsCodeColor(value: unknown): Rgba | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("color(")) return parseColorFunction(trimmed);
  const hex = trimmed.replace(/^#/, "");
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
  const expand = (part: string) => (part.length === 1 ? Number.parseInt(part + part, 16) : Number.parseInt(part, 16));
  if (hex.length <= 4) {
    return { r: expand(hex[0]!), g: expand(hex[1]!), b: expand(hex[2]!), a: hex.length === 4 ? expand(hex[3]!) / 255 : 1 };
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}

function toHex(color: Rgb): string {
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

// Composite VS Code translucent overlays onto their surfaces; our roles are opaque.
function flattenOver(color: Rgba, base: Rgb): string {
  if (color.a >= 1) return toHex(color);
  return toHex({ r: color.r * color.a + base.r * (1 - color.a), g: color.g * color.a + base.g * (1 - color.a), b: color.b * color.a + base.b * (1 - color.a) });
}

function relativeLuminance(color: Rgb): number {
  const channel = (value: number) => {
    const ratio = value / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrastRatio(first: Rgb, second: Rgb): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const hexToRgb = (value: string): Rgb => parseVsCodeColor(themeColorToHex(value) ?? value) ?? { r: 0, g: 0, b: 0 };

export function isVsCodeThemeFile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.version === THEME_FILE_VERSION) return false;
  const hasWorkbenchColors = isRecord(value.colors) && Object.keys(value.colors).some((key) => key.includes("."));
  return hasWorkbenchColors || Array.isArray(value.tokenColors);
}

// --- JSONC -------------------------------------------------------------------------------------------------

/**
 * Parses JSON with comments and trailing commas (what VS Code theme files are written in), or throws. It is
 * strict about everything else, as the web's use of jsonc-parser is: a missing comma, an unterminated comment or
 * text after the value is an error, not something to recover from.
 */
export function parseJsonc(source: string): unknown {
  let out = "";
  let index = 0;
  const length = source.length;
  while (index < length) {
    const char = source[index]!;
    if (char === '"') {
      let end = index + 1;
      while (end < length && source[end] !== '"') end += source[end] === "\\" ? 2 : 1;
      if (end >= length) throw new SyntaxError("Unterminated string");
      out += source.slice(index, end + 1);
      index = end + 1;
    } else if (char === "/" && source[index + 1] === "/") {
      while (index < length && source[index] !== "\n" && source[index] !== "\r") index += 1;
    } else if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) throw new SyntaxError("Unterminated comment");
      out += " ";
      index = end + 2;
    } else {
      out += char;
      index += 1;
    }
  }
  // A comma followed only by whitespace and a closing bracket is a trailing comma.
  out = out.replace(/("(?:\\.|[^"\\])*")|,(\s*[}\]])/g, (_match, string: string | undefined, close: string | undefined) => string ?? close ?? "");
  return JSON.parse(out.replace(/^\uFEFF/, ""));
}

export function parseThemeImport(source: string): ThemeDefinition {
  let value: unknown;
  try {
    value = parseJsonc(source);
  } catch {
    throw new Error("That theme file is not valid JSON.");
  }
  return isVsCodeThemeFile(value) ? parseVsCodeThemeFile(value) : parseThemeFile(JSON.parse(source));
}

function resolveAppearance(value: Record<string, unknown>, canvas: Rgb): ThemeAppearance {
  const type = typeof value.type === "string" ? value.type.toLowerCase() : null;
  if (type === "light" || type === "hc-light") return "light";
  if (type === "dark" || type === "hc-black") return "dark";
  return relativeLuminance(canvas) < 0.179 ? "dark" : "light";
}

export function humanizeThemeName(raw: string): string {
  const trimmed = raw.trim();
  if (/\s/.test(trimmed) || !/[-_.]/.test(trimmed)) return trimmed;
  return trimmed.split(/[-_.]+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function resolveName(value: Record<string, unknown>): string {
  for (const candidate of [value.displayName, value.name]) {
    if (typeof candidate !== "string") continue;
    const humanized = humanizeThemeName(candidate);
    if (humanized.length > 0) return humanized.slice(0, 48);
  }
  return "VS Code theme";
}

export function parseVsCodeThemeFile(value: unknown): ThemeDefinition {
  if (!isRecord(value)) throw new Error("Theme files must contain a JSON object.");
  const colors = isRecord(value.colors) ? value.colors : {};

  const pick = (...keys: string[]): Rgba | null => {
    for (const key of keys) {
      const parsed = parseVsCodeColor(colors[key]);
      if (parsed) return parsed;
    }
    return null;
  };
  const solidOver = (base: Rgb, ...keys: string[]): string | null => {
    const parsed = pick(...keys);
    return parsed ? flattenOver(parsed, base) : null;
  };

  const canvasColor = pick("editor.background", "editorPane.background");
  if (!canvasColor) {
    throw new Error('That VS Code theme has no "editor.background" color, so there is nothing to build a palette from.');
  }
  const canvas = { r: canvasColor.r, g: canvasColor.g, b: canvasColor.b };
  const appearance = resolveAppearance(value, canvas);

  const canvasHex = toHex(canvas);
  const raisedSurfaceCandidateHex = solidOver(canvas, "editorWidget.background", "dropdown.background");

  const standsApart = (first: string, second: string) => contrastRatio(hexToRgb(first), hexToRgb(second)) >= 1.1;

  let accentColor: Rgba | null = null;
  let accentHex: string | null = null;
  for (const key of ["focusBorder", "button.background", "textLink.foreground", "activityBarBadge.background", "progressBar.background", "badge.background"]) {
    const candidate = parseVsCodeColor(colors[key]);
    if (!candidate) continue;
    const candidateHex = flattenOver(candidate, canvas);
    if (!standsApart(candidateHex, canvasHex) || (raisedSurfaceCandidateHex !== null && !standsApart(candidateHex, raisedSurfaceCandidateHex))) continue;
    accentColor = candidate;
    accentHex = candidateHex;
    break;
  }
  if (!accentColor || !accentHex) {
    const standardAccentHex = themeColorToHex(getStandardThemeColors(appearance).accent)!;
    accentHex =
      [standardAccentHex, "#ffffff", "#000000"].find(
        (candidate) => standsApart(candidate, canvasHex) && (raisedSurfaceCandidateHex === null || standsApart(candidate, raisedSurfaceCandidateHex)),
      ) ?? standardAccentHex;
    accentColor = parseVsCodeColor(accentHex)!;
  }

  const mutedAccentHex = flattenOver({ r: accentColor.r, g: accentColor.g, b: accentColor.b, a: 0.2 }, canvas);
  const derived = createVividThemeColors(appearance, canvasHex, mutedAccentHex);
  const sidebarHex = solidOver(canvas, "sideBar.background", "activityBar.background") ?? derived.sidebar;
  const sidebar = hexToRgb(sidebarHex);
  const terminalHex = solidOver(canvas, "terminal.background", "panel.background") ?? derived.terminalBackground;
  const terminal = hexToRgb(terminalHex);

  const readableOn = (surface: string, fallback: string, ...keys: string[]): string => {
    const surfaceRgb = hexToRgb(surface);
    const isReadable = (candidate: string) => contrastRatio(hexToRgb(candidate), surfaceRgb) >= 4.5;
    const specified = solidOver(surfaceRgb, ...keys);
    if (specified && isReadable(specified)) return specified;
    if (isReadable(fallback)) return fallback;
    return relativeLuminance(surfaceRgb) < 0.179 ? "#ffffff" : "#000000";
  };
  // Status colors also fill controls such as destructive buttons, which carry white text, so a dim one is lightened
  // along its hue rather than replaced by readableOn's black or white. One hidden in the canvas has no hue to keep,
  // so the derived color stands in.
  const readableStatusColor = (fallback: string, ...keys: string[]): string => {
    const specified = solidOver(canvas, ...keys);
    const base = specified && standsApart(specified, canvasHex) ? specified : fallback;
    return readableThemeColorOn(base, canvasHex, 4.5);
  };

  const surfaceRaisedHex = raisedSurfaceCandidateHex ?? derived.surfaceRaised;
  // Checked tracks use messageAction; resolve it before the unchecked input role.
  const buttonHex = solidOver(canvas, "button.background");
  const actionHex = buttonHex && standsApart(buttonHex, canvasHex) && standsApart(buttonHex, surfaceRaisedHex) ? buttonHex : accentHex;
  const inputCandidates = [derived.input, derived.surfaceRaised, getStandardThemeColors(appearance).input, "#000000", "#ffffff", "#808080"];
  let inputHex = inputCandidates.find((candidate) => standsApart(candidate, canvasHex) && standsApart(candidate, actionHex)) ?? "#808080";
  for (const key of ["input.background", "input.border"]) {
    const candidate = solidOver(canvas, key);
    if (candidate && standsApart(candidate, canvasHex) && standsApart(candidate, actionHex)) {
      inputHex = candidate;
      break;
    }
  }
  const searchMatchBackground = solidOver(canvas, "editor.findMatchHighlightBackground") ?? derived.searchMatchBackground;
  const searchMatchActiveBackground = solidOver(canvas, "editor.findMatchBackground") ?? derived.searchMatchActiveBackground;

  const overrides: Partial<Record<ThemeColorRole, string>> = {
    canvas: canvasHex,
    text: readableOn(canvasHex, derived.text, "editor.foreground", "foreground"),
    textMuted: readableOn(canvasHex, derived.textMuted, "descriptionForeground", "disabledForeground"),
    surface: solidOver(canvas, "editorWidget.background") ?? derived.surface,
    surfaceRaised: surfaceRaisedHex,
    surfaceOverlay: solidOver(canvas, "menu.background", "quickInput.background", "dropdown.background") ?? derived.surfaceOverlay,
    border: solidOver(canvas, "panel.border", "editorGroup.border", "contrastBorder") ?? derived.border,
    input: inputHex,
    placeholder: readableOn(surfaceRaisedHex, derived.placeholder, "input.placeholderForeground"),
    error: readableStatusColor(derived.error, "editorError.foreground", "errorForeground"),
    warning: readableStatusColor(derived.warning, "editorWarning.foreground"),
    accentSurface: solidOver(canvas, "list.activeSelectionBackground", "list.hoverBackground") ?? derived.accentSurface,
    codeBackground: solidOver(canvas, "textCodeBlock.background") ?? derived.codeBackground,
    searchMatchBackground,
    searchMatchForeground: readableOn(searchMatchBackground, derived.searchMatchForeground, "editor.findMatchHighlightForeground", "editor.foreground", "foreground"),
    searchMatchActiveBackground,
    searchMatchActiveForeground: readableOn(searchMatchActiveBackground, derived.searchMatchActiveForeground, "editor.findMatchForeground", "editor.foreground", "foreground"),
    sidebar: sidebarHex,
    sidebarForeground: readableOn(sidebarHex, derived.sidebarForeground, "sideBar.foreground"),
    sidebarBorder: solidOver(sidebar, "sideBar.border") ?? derived.sidebarBorder,
    sidebarRowHover: solidOver(sidebar, "list.hoverBackground") ?? derived.sidebarRowHover,
    sidebarRowActive: solidOver(sidebar, "list.inactiveSelectionBackground", "list.hoverBackground") ?? derived.sidebarRowActive,
    sidebarRowSelected: solidOver(sidebar, "list.activeSelectionBackground") ?? derived.sidebarRowSelected,
    terminalBackground: terminalHex,
    terminalForeground: readableOn(terminalHex, derived.terminalForeground, "terminal.foreground"),
    terminalCursor: solidOver(terminal, "terminalCursor.foreground", "editorCursor.foreground") ?? derived.terminalCursor,
    terminalSelection: solidOver(terminal, "terminal.selectionBackground", "editor.selectionBackground") ?? derived.terminalSelection,
    terminalScrollbar: solidOver(terminal, "scrollbarSlider.background") ?? derived.terminalScrollbar,
  };
  overrides.accent = accentHex;
  overrides.focus = accentHex;
  overrides.messageAction = actionHex;
  overrides.messageActionForeground = readableOn(actionHex, derived.messageActionForeground, "button.foreground");
  overrides.accentForeground = readableOn(accentHex, derived.accentForeground, "button.foreground");

  const name = resolveName(value);
  const generatedId = themeIdFromName(name);
  return parseThemeFile({
    version: THEME_FILE_VERSION,
    ...(isReservedThemeId(generatedId) ? { id: `${generatedId}-vscode` } : {}),
    name,
    appearance,
    colors: { ...derived, ...overrides },
  });
}

/**
 * A family's light and dark files become one dual-mode theme ("github-dark" and "github-light" are "Github");
 * anything that does not pair one to one is left as it is.
 */
export function pairVsCodeThemes(themes: ReadonlyArray<ThemeDefinition>, options?: { pairedId?: (light: ThemeDefinition, dark: ThemeDefinition) => string }): ThemeDefinition[] {
  const stripAppearance = (label: string) => label.replace(/\b(?:light|dark)\b/gi, " ").replace(/\s+/g, " ").trim();

  interface Group { light: ThemeDefinition[]; dark: ThemeDefinition[]; order: number }
  const groups = new Map<string, Group>();
  const passthrough: { theme: ThemeDefinition; order: number }[] = [];
  themes.forEach((theme, order) => {
    const key = stripAppearance(theme.label);
    if (getThemeModes(theme).length !== 1 || key === theme.label || !/[a-z0-9]/i.test(key)) {
      passthrough.push({ theme, order });
      return;
    }
    const group = groups.get(key) ?? { light: [], dark: [], order };
    group[theme.appearance].push(theme);
    groups.set(key, group);
  });

  const paired: { theme: ThemeDefinition; order: number }[] = [];
  for (const [key, group] of groups) {
    if (group.light.length === 1 && group.dark.length === 1) {
      try {
        paired.push({
          order: group.order,
          theme: parseThemeFile({
            version: THEME_FILE_VERSION,
            ...(options?.pairedId ? { id: options.pairedId(group.light[0]!, group.dark[0]!) } : {}),
            name: key,
            appearance: "light",
            colors: group.light[0]!.colors,
            variants: { dark: group.dark[0]!.colors },
          }),
        });
        continue;
      } catch { /* a family that cannot be paired stays as separate themes */ }
    }
    for (const theme of [...group.light, ...group.dark]) paired.push({ theme, order: group.order });
  }
  return [...passthrough, ...paired].sort((a, b) => a.order - b.order).map((entry) => entry.theme);
}

/** Themes whose labels (so ids) collide are told apart by their file names, then numbered. */
export function resolveThemeLabelCollisions(entries: ReadonlyArray<{ theme: ThemeDefinition; sourceName?: string | undefined }>): ThemeDefinition[] {
  const rename = (theme: ThemeDefinition, name: string): ThemeDefinition | null => {
    try {
      return parseThemeFile({
        version: THEME_FILE_VERSION,
        name: name.slice(0, 48),
        appearance: theme.appearance,
        colors: theme.colors,
        ...(theme.variants ? { variants: theme.variants } : {}),
        ...(theme.managed ? { managed: true } : {}),
      });
    } catch {
      return null;
    }
  };

  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.theme.id, (counts.get(entry.theme.id) ?? 0) + 1);
  const relabelled = entries.map(({ theme, sourceName }) => {
    if ((counts.get(theme.id) ?? 0) < 2) return theme;
    const stem = sourceName?.replace(/\.[^.]+$/, "");
    const fromFile = stem ? humanizeThemeName(stem) : null;
    const renamed = fromFile && fromFile.toLowerCase() !== theme.label.toLowerCase() ? rename(theme, fromFile) : null;
    return renamed ?? theme;
  });

  const seen = new Set<string>();
  return relabelled.map((theme) => {
    if (!seen.has(theme.id)) {
      seen.add(theme.id);
      return theme;
    }
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const candidate = rename(theme, `${theme.label} ${suffix}`);
      if (candidate && !seen.has(candidate.id)) {
        seen.add(candidate.id);
        return candidate;
      }
    }
    return theme;
  });
}
