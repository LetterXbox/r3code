// The colour model of themes, ported from apps/web/src/themePalette.ts: reading a literal CSS colour, the OKLCH
// helpers, the contrast-solving that keeps derived text readable, `createVividThemeColors` (a whole palette from
// two colours), `updateThemeColorFamily` (what the advanced editor rewrites when one role changes) and the
// light/dark lookups of a theme. Pure: no signals, no storage (customThemes.ts keeps the library).
//
// The web keeps colours as canonical `oklch()` strings and parses them with culori. This app keeps hex
// (`#rrggbb` or `#rrggbbaa`): tools/build_theme.py and the preview circles read hex, and 8-bit hex is what the
// web's own derivations round to. `parseThemeColor` reads the CSS forms a theme file may use (hex, rgb(), hsl(),
// oklch(), oklab(), color(srgb ...) and color(display-p3 ...)) and every function here that returns a colour
// returns hex.
import { BUILT_IN_PALETTES, STANDARD_COLORS, THEME_COLOR_ROLES, type ThemeColorRole, type ThemeColors } from "../../themePaletteData";

export { THEME_COLOR_ROLES };
export type { ThemeColorRole, ThemeColors };
export type ThemeAppearance = "light" | "dark";
export type ThemeVariants = Partial<Record<ThemeAppearance, ThemeColors>>;

export interface ThemeDefinition {
  id: string;
  label: string;
  appearance: ThemeAppearance;
  colors: ThemeColors;
  variants?: ThemeVariants;
  collection?: { id: string; label: string };
  managed?: boolean;
}

interface Rgb { r: number; g: number; b: number }
interface Oklch { L: number; C: number; h: number }
interface Parsed { color: Oklch; alpha: number }

const LIGHT_FOREGROUND: Rgb = { r: 255, g: 250, b: 255 };
const DARK_FOREGROUND: Rgb = { r: 36, g: 21, b: 35 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

// --- sRGB / OKLCH ------------------------------------------------------------------------------------------

const toLinear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

function fromLinear(channel: number, round = true): number {
  const c = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
  const srgb = Math.min(1, Math.max(0, c)) * 255;
  return round ? Math.round(srgb) : srgb;
}

function rgbToOklch(color: Rgb): Oklch {
  const r = toLinear(color.r);
  const g = toLinear(color.g);
  const b = toLinear(color.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180) / Math.PI };
}

function oklchToLinearUnclamped({ L, C, h }: Oklch): Rgb {
  const hr = (h * Math.PI) / 180;
  return oklabToLinearUnclamped(L, C * Math.cos(hr), C * Math.sin(hr));
}

function oklabToLinearUnclamped(L: number, a: number, bb: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

/** Pulls an out-of-gamut colour back by lowering its chroma, the way CSS gamut mapping does. */
function mapToSrgbGamut(color: Oklch): Oklch {
  const inGamut = (C: number) => {
    const linear = oklchToLinearUnclamped({ ...color, C });
    return [linear.r, linear.g, linear.b].every((channel) => channel >= -0.0001 && channel <= 1.0001);
  };
  if (inGamut(color.C)) return color;
  let low = 0;
  let high = color.C;
  const resolution = 0.000001;
  const steps = Math.max(1, Math.ceil(Math.log2(Math.max(color.C, resolution)) - Math.log2(resolution)));
  for (let step = 0; step < steps; step += 1) {
    const mid = (low + high) / 2;
    if (inGamut(mid)) low = mid;
    else high = mid;
  }
  return { ...color, C: low };
}

function oklchToRgb(color: Oklch, round = true): Rgb {
  const linear = oklchToLinearUnclamped(mapToSrgbGamut(color));
  return { r: fromLinear(linear.r, round), g: fromLinear(linear.g, round), b: fromLinear(linear.b, round) };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

// --- reading a CSS colour ----------------------------------------------------------------------------------

function hexToRgba(text: string): { rgb: Rgb; alpha: number } | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (!m || ![3, 4, 6, 8].includes(m[1]!.length)) return null;
  let h = m[1]!;
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  return {
    rgb: { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) },
    alpha: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
  };
}

function splitArguments(body: string): { parts: string[]; alpha: string | null } | null {
  const slash = body.split("/");
  if (slash.length > 2) return null;
  const main = slash[0]!.trim();
  const parts = (main.includes(",") ? main.split(",") : main.split(/\s+/)).map((part) => part.trim()).filter((part) => part.length > 0);
  let alpha = slash[1]?.trim() ?? null;
  if (alpha === null && main.includes(",") && parts.length === 4) alpha = parts.pop()!;
  return { parts, alpha };
}

function numberOf(part: string, percentScale: number): number | null {
  if (/^none$/i.test(part)) return 0;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg|turn|rad|grad)?$/i.exec(part);
  if (!m) return null;
  const value = Number.parseFloat(m[1]!);
  if (m[2] === "%") return (value / 100) * percentScale;
  if (m[2] === "turn") return value * 360;
  if (m[2] === "rad") return (value * 180) / Math.PI;
  if (m[2] === "grad") return value * 0.9;
  return value;
}

function alphaOf(raw: string | null): number | null {
  if (raw === null) return 1;
  const value = numberOf(raw, 1);
  return value === null ? null : clamp01(value);
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = (((h % 360) + 360) % 360) / 360;
  const sat = clamp01(s / 100);
  const light = clamp01(l / 100);
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const channel = (t: number) => {
    const x = (t + 1) % 1;
    const v = x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p;
    return v * 255;
  };
  return { r: channel(hue + 1 / 3), g: channel(hue), b: channel(hue - 1 / 3) };
}

/** A literal CSS colour as OKLCH plus alpha, or null when it is not one this reader knows. */
export function parseThemeColor(value: unknown): Parsed | null {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (input.length === 0) return null;
  const toParsed = (rgb: Rgb, alpha: number): Parsed => {
    const color = rgbToOklch(rgb);
    return { color: { L: clamp01(color.L), C: Math.max(0, color.C), h: color.h }, alpha };
  };
  const hex = hexToRgba(input);
  if (hex) return toParsed(hex.rgb, hex.alpha);
  if (/^transparent$/i.test(input)) return toParsed({ r: 0, g: 0, b: 0 }, 0);
  const fn = /^([a-z0-9-]+)\(\s*([\s\S]*)\)$/i.exec(input);
  if (!fn) return null;
  const name = fn[1]!.toLowerCase();
  const args = splitArguments(fn[2]!);
  if (!args) return null;
  const alpha = alphaOf(args.alpha);
  if (alpha === null) return null;
  const { parts } = args;
  if (parts.length !== 3 && !(name === "color" && parts.length === 4)) return null;
  if (name === "rgb" || name === "rgba") {
    const channels = parts.map((part) => numberOf(part, 255));
    if (channels.some((channel) => channel === null)) return null;
    const [r, g, b] = channels as [number, number, number];
    return toParsed({ r: Math.min(255, Math.max(0, r)), g: Math.min(255, Math.max(0, g)), b: Math.min(255, Math.max(0, b)) }, alpha);
  }
  if (name === "hsl" || name === "hsla") {
    const h = numberOf(parts[0]!, 360);
    const s = numberOf(parts[1]!, 100);
    const l = numberOf(parts[2]!, 100);
    if (h === null || s === null || l === null) return null;
    return toParsed(hslToRgb(h, s, l), alpha);
  }
  if (name === "oklch") {
    const L = numberOf(parts[0]!, 1);
    const C = numberOf(parts[1]!, 0.4);
    const h = numberOf(parts[2]!, 360);
    if (L === null || C === null || h === null) return null;
    return { color: { L: clamp01(L), C: Math.max(0, C), h }, alpha };
  }
  if (name === "oklab") {
    const L = numberOf(parts[0]!, 1);
    const a = numberOf(parts[1]!, 0.4);
    const b = numberOf(parts[2]!, 0.4);
    if (L === null || a === null || b === null) return null;
    return { color: { L: clamp01(L), C: Math.hypot(a, b), h: (Math.atan2(b, a) * 180) / Math.PI }, alpha };
  }
  if (name === "color") {
    const space = parts[0]!.toLowerCase();
    const channels = parts.slice(1).map((part) => numberOf(part, 1));
    if (channels.some((channel) => channel === null) || parts.length !== 4) return null;
    const [x, y, z] = channels as [number, number, number];
    if (space === "srgb") return toParsed({ r: x * 255, g: y * 255, b: z * 255 }, alpha);
    if (space === "display-p3") {
      const [lr, lg, lb] = [x, y, z].map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
      const srgb = [
        1.2249401762805 * lr - 0.2249401762805 * lg,
        -0.042056961239 * lr + 1.042056961239 * lg,
        -0.0196375547643 * lr - 0.0786360655012 * lg + 1.0982736202656 * lb,
      ].map((channel) => fromLinear(channel, false));
      return toParsed({ r: srgb[0]!, g: srgb[1]!, b: srgb[2]! }, alpha);
    }
  }
  return null;
}

export function isThemeColor(value: unknown): value is string {
  return parseThemeColor(value) !== null;
}

const hexPair = (channel: number) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0");
const rgbToHex = (color: Rgb) => `#${hexPair(color.r)}${hexPair(color.g)}${hexPair(color.b)}`;

/** `#rrggbb` (or `#rrggbbaa` for a translucent colour) of any colour this reader knows, null otherwise. */
export function themeColorToHex(value: string): string | null {
  const parsed = parseThemeColor(value);
  if (!parsed) return null;
  const opaque = rgbToHex(oklchToRgb(parsed.color));
  return parsed.alpha >= 1 ? opaque : `${opaque}${hexPair(parsed.alpha * 255)}`;
}

/** What a theme file's colour is stored as: hex. */
export const toCanonicalThemeColor = themeColorToHex;

function rgbOf(value: string, fallback: Rgb): Rgb {
  const parsed = parseThemeColor(value);
  return parsed ? oklchToRgb(parsed.color) : fallback;
}

const themeColorOfRgb = (color: Rgb) => rgbToHex(color);
const themeColorOfOklch = (color: Oklch) => rgbToHex(oklchToRgb(color));

// --- contrast ----------------------------------------------------------------------------------------------

function mixRgb(base: Rgb, overlay: Rgb, amount: number): Rgb {
  return { r: base.r + (overlay.r - base.r) * amount, g: base.g + (overlay.g - base.g) * amount, b: base.b + (overlay.b - base.b) * amount };
}

export function relativeLuminance(color: Rgb): number {
  const linearize = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

export function contrastRatio(first: Rgb, second: Rgb): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function solveLightness(base: Oklch, against: ReadonlyArray<Rgb>, minContrast: number, direction: "lighter" | "darker"): Oklch {
  const contrastOf = (color: Oklch) => Math.min(...against.map((surface) => contrastRatio(oklchToRgb(color), surface)));
  let low = direction === "lighter" ? base.L : 0;
  let high = direction === "lighter" ? 1 : base.L;
  let candidate = { ...base };
  if (contrastOf(candidate) >= minContrast) return candidate;
  for (let step = 0; step < 18; step += 1) {
    const mid = (low + high) / 2;
    candidate = { ...base, L: mid };
    if (contrastOf(candidate) >= minContrast) {
      if (direction === "lighter") high = mid;
      else low = mid;
    } else if (direction === "lighter") low = mid;
    else high = mid;
  }
  return { ...base, L: direction === "lighter" ? high : low };
}

/** Moves only the lightness, so a colour that is too dim on `surface` keeps its hue instead of collapsing to black or white. */
export function readableThemeColorOn(color: string, surface: string, minContrast: number): string {
  const parsedColor = parseThemeColor(color);
  const parsedSurface = parseThemeColor(surface);
  if (!parsedColor || !parsedSurface) return color;
  const surfaceRgb = oklchToRgb(parsedSurface.color);
  if (contrastRatio(oklchToRgb(parsedColor.color), surfaceRgb) >= minContrast) return color;
  const direction = relativeLuminance(surfaceRgb) < 0.179 ? "lighter" : "darker";
  const solved = solveLightness(parsedColor.color, [surfaceRgb], minContrast, direction);
  return rgbToHex(oklchToRgb(solved));
}

function readableForeground(background: Rgb): Rgb {
  const lightContrast = contrastRatio(background, LIGHT_FOREGROUND);
  const darkContrast = contrastRatio(background, DARK_FOREGROUND);
  if (Math.max(lightContrast, darkContrast) >= 4.5) return lightContrast >= darkContrast ? LIGHT_FOREGROUND : DARK_FOREGROUND;
  return contrastRatio(background, WHITE) >= contrastRatio(background, BLACK) ? WHITE : BLACK;
}

function readableText(background: Rgb, foreground: Rgb, amount: number, minimumRatio: number): Rgb {
  const softened = mixRgb(foreground, background, amount);
  if (contrastRatio(softened, background) >= minimumRatio) return softened;
  let readable = foreground;
  let lowerAmount = 0;
  let upperAmount = amount;
  for (let index = 0; index < 12; index += 1) {
    const candidateAmount = (lowerAmount + upperAmount) / 2;
    const candidate = mixRgb(foreground, background, candidateAmount);
    if (contrastRatio(candidate, background) >= minimumRatio) {
      readable = candidate;
      lowerAmount = candidateAmount;
    } else upperAmount = candidateAmount;
  }
  return readable;
}

const STANDARD_LIGHT_MUTED_CONTRAST = 4.705;
const STANDARD_DARK_MUTED_CONTRAST = 5.082;

function standardMutedText(background: Rgb, foreground: Rgb): Rgb {
  const target = relativeLuminance(background) < 0.179 ? STANDARD_DARK_MUTED_CONTRAST : STANDARD_LIGHT_MUTED_CONTRAST;
  return readableText(background, foreground, 1, target);
}

// --- the palettes ------------------------------------------------------------------------------------------

export function getStandardThemeColors(appearance: ThemeAppearance): ThemeColors {
  return { ...STANDARD_COLORS[appearance] };
}

const T3_CHAT = BUILT_IN_PALETTES.find((theme) => theme.id === "t3-chat")!;

/** getDefaultThemeColors: what a theme file's missing roles take, T3 Chat's palette of that appearance. */
export function getDefaultThemeColors(appearance: ThemeAppearance): ThemeColors {
  return { ...(appearance === "dark" ? T3_CHAT.variants!.dark! : T3_CHAT.colors) };
}

export const BUILT_IN_THEME_DEFINITIONS: ReadonlyArray<ThemeDefinition> = BUILT_IN_PALETTES.map((theme) => ({
  id: theme.id,
  label: theme.label,
  appearance: theme.appearance,
  colors: theme.colors,
  ...(theme.variants ? { variants: theme.variants } : {}),
}));

/** Whether a built-in theme paints the sidebar's stage artwork (`themeAllowsSidebarArtwork`): custom themes never do. */
export function themeAllowsSidebarArtwork(themeId: string): boolean {
  return BUILT_IN_PALETTES.find((theme) => theme.id === themeId)?.sidebarArtwork === true;
}

export function getThemeColorsForMode(theme: ThemeDefinition, mode: ThemeAppearance): ThemeColors | null {
  if (mode === theme.appearance) return theme.colors;
  return theme.variants?.[mode] ?? null;
}

export function getThemeModes(theme: ThemeDefinition): ThemeAppearance[] {
  return (["light", "dark"] as const).filter((mode) => getThemeColorsForMode(theme, mode) !== null);
}

/** The appearance a theme is limited to, null for one that has both. */
export function singleAppearanceOf(theme: ThemeDefinition): ThemeAppearance | null {
  const modes = getThemeModes(theme);
  return modes.length === 1 ? modes[0]! : null;
}

const STANDARD_STATUS_COLORS = {
  light: { error: "#fb2c36", errorForeground: "#c10007", warning: "#fe9a00", warningForeground: "#bb4d00" },
  dark: { error: "#fb414a", errorForeground: "#ff6467", warning: "#fe9a00", warningForeground: "#ffb900" },
} as const;

function standardStatusColors(canvas: Rgb) {
  const appearance: ThemeAppearance = relativeLuminance(canvas) < 0.179 ? "dark" : "light";
  const standard = STANDARD_STATUS_COLORS[appearance];
  const surfaceMix = appearance === "dark" ? 0.16 : 0.08;
  const surfaceOf = (value: string) => mixRgb(canvas, rgbOf(value, canvas), surfaceMix);
  const readableOn = (foreground: string, surface: Rgb) =>
    themeColorOfOklch(solveLightness(rgbToOklch(rgbOf(foreground, canvas)), [surface], 4.6, appearance === "dark" ? "lighter" : "darker"));
  const errorSurface = surfaceOf(standard.error);
  const warningSurface = surfaceOf(standard.warning);
  return {
    error: themeColorToHex(standard.error)!,
    errorForeground: readableOn(standard.errorForeground, errorSurface),
    errorSurface: themeColorOfRgb(errorSurface),
    warning: themeColorToHex(standard.warning)!,
    warningForeground: readableOn(standard.warningForeground, warningSurface),
    warningSurface: themeColorOfRgb(warningSurface),
  };
}

/** A whole palette from a background and an accent: every other role is derived from the two. */
export function createVividThemeColors(appearance: ThemeAppearance, backgroundValue: string, accentValue: string): ThemeColors {
  const defaults = getDefaultThemeColors(appearance);
  const canvasRgb = rgbOf(backgroundValue, appearance === "dark" ? { r: 24, g: 15, b: 27 } : { r: 250, g: 245, b: 250 });
  const accentRgb = rgbOf(accentValue, { r: 168, g: 67, b: 112 });
  const canvas = rgbToOklch(canvasRgb);
  const accent = rgbToOklch(accentRgb);
  // At luminance 0.179, black and white text have equal contrast.
  const dark = relativeLuminance(canvasRgb) < 0.179;
  const hue = accent.C < 0.02 ? canvas.h : accent.h;
  const tintC = Math.min(0.045, Math.max(0.008, accent.C * 0.22));
  const step = dark ? 1 : -1;

  const surfaceAt = (deltaL: number, chroma = tintC): Oklch => ({ L: Math.min(0.98, Math.max(0.05, canvas.L + step * deltaL)), C: chroma, h: hue });
  const themeColor = (color: Oklch) => themeColorOfOklch(color);

  const textBase: Oklch = { L: dark ? 0.95 : 0.2, C: Math.min(0.035, accent.C * 0.25), h: hue };
  const text = solveLightness(textBase, [canvasRgb], 7, dark ? "lighter" : "darker");
  const textRgb = oklchToRgb(text);
  const textMutedRgb = standardMutedText(canvasRgb, textRgb);

  const action: Oklch = { L: Math.min(0.85, Math.max(0.35, accent.L + (dark ? 0.06 : -0.02))), C: Math.max(accent.C * 0.9, 0.06), h: (hue + 50) % 360 };
  const actionRgb = oklchToRgb(action);
  const actionForeground = readableForeground(actionRgb);
  const accentForeground = readableForeground(accentRgb);

  const sidebar = surfaceAt(0.045, tintC * 1.4);
  const sidebarRgb = oklchToRgb(sidebar);
  const surface = surfaceAt(0.015);
  const surfaceRaised = surfaceAt(0.05);
  const surfaceRaisedRgb = oklchToRgb(surfaceRaised);
  const surfaceOverlay = surfaceAt(0.075);
  const border = surfaceAt(dark ? 0.16 : 0.12, Math.min(0.07, accent.C * 0.35));
  const input = surfaceAt(dark ? 0.21 : 0.16, Math.min(0.08, accent.C * 0.4));
  const secondary = surfaceAt(dark ? 0.1 : 0.06, Math.min(0.09, accent.C * 0.5));
  const secondaryRgb = oklchToRgb(secondary);
  const muted = surfaceAt(dark ? 0.06 : 0.04, Math.min(0.06, accent.C * 0.35));
  const mutedRgb = oklchToRgb(muted);
  const accentSurface = surfaceAt(dark ? 0.13 : 0.08, Math.min(0.11, accent.C * 0.55));
  const accentSurfaceRgb = oklchToRgb(accentSurface);
  const messageSurface = surfaceAt(dark ? 0.16 : 0.1, Math.min(0.13, accent.C * 0.6));
  const messageSurfaceRgb = oklchToRgb(messageSurface);
  const codeBackground = surfaceAt(0.035, tintC * 0.8);
  const updateSurface = surfaceAt(dark ? 0.14 : 0.09, Math.min(0.12, accent.C * 0.55));

  const foregroundOn = (surfaceRgb: Rgb): string => themeColorOfOklch(solveLightness(textBase, [surfaceRgb], 4.6, dark ? "lighter" : "darker"));
  const mutedForeground = themeColorOfRgb(readableText(mutedRgb, textRgb, 1, 4.6));
  const placeholder = themeColorOfRgb(readableText(surfaceRaisedRgb, textRgb, 1, 4.6));

  const searchMatch = oklchToRgb(surfaceAt(0.22, Math.min(0.12, accent.C)));
  const searchMatchActive = oklchToRgb(surfaceAt(0.4, Math.min(0.18, accent.C)));
  const actionHover: Oklch = { ...action, L: action.L + (dark ? 0.06 : -0.06) };

  return {
    ...defaults,
    ...standardStatusColors(canvasRgb),
    canvas: themeColorOfRgb(canvasRgb),
    chrome: themeColorOfRgb(canvasRgb),
    toolbar: themeColorOfRgb(canvasRgb),
    toolbarForeground: themeColorOfRgb(textRgb),
    toolbarBorder: themeColor(surfaceAt(dark ? 0.14 : 0.1, Math.min(0.08, accent.C * 0.4))),
    toolbarControl: themeColor(surfaceAt(dark ? 0.09 : 0.05, tintC * 1.3)),
    toolbarControlForeground: themeColorOfRgb(textRgb),
    toolbarControlHover: themeColor(surfaceAt(dark ? 0.14 : 0.09, tintC * 1.6)),
    surface: themeColor(surface),
    surfaceRaised: themeColor(surfaceRaised),
    surfaceOverlay: themeColor(surfaceOverlay),
    text: themeColorOfRgb(textRgb),
    textMuted: themeColorOfRgb(textMutedRgb),
    border: themeColor(border),
    input: themeColor(input),
    focus: themeColorOfRgb(accentRgb),
    accent: themeColorOfRgb(accentRgb),
    accentForeground: themeColorOfRgb(accentForeground),
    secondary: themeColor(secondary),
    secondaryForeground: foregroundOn(secondaryRgb),
    muted: themeColor(muted),
    mutedForeground,
    placeholder,
    secondaryLabel: themeColorOfRgb(textMutedRgb),
    iconMuted: themeColorOfRgb(textMutedRgb),
    update: themeColorOfRgb(accentRgb),
    updateForeground: foregroundOn(oklchToRgb(updateSurface)),
    updateSurface: themeColor(updateSurface),
    accentSurface: themeColor(accentSurface),
    accentSurfaceForeground: foregroundOn(accentSurfaceRgb),
    messageSurface: themeColor(messageSurface),
    messageForeground: foregroundOn(messageSurfaceRgb),
    messageAction: themeColorOfRgb(actionRgb),
    messageActionForeground: themeColorOfRgb(actionForeground),
    messageActionHover: themeColor(actionHover),
    codeBackground: themeColor(codeBackground),
    codeForeground: themeColorOfRgb(textRgb),
    searchMatchBackground: themeColorOfRgb(searchMatch),
    searchMatchForeground: themeColorOfRgb(readableForeground(searchMatch)),
    searchMatchActiveBackground: themeColorOfRgb(searchMatchActive),
    searchMatchActiveForeground: themeColorOfRgb(readableForeground(searchMatchActive)),
    sidebar: themeColor(sidebar),
    sidebarForeground: foregroundOn(sidebarRgb),
    sidebarMutedForeground: themeColorOfRgb(standardMutedText(sidebarRgb, textRgb)),
    sidebarControlSurface: themeColor(surfaceAt(dark ? 0.1 : 0.07, tintC * 1.5)),
    sidebarRowHover: themeColor(surfaceAt(dark ? 0.08 : 0.06, Math.min(0.08, accent.C * 0.45))),
    sidebarRowActive: themeColor(surfaceAt(dark ? 0.12 : 0.09, Math.min(0.1, accent.C * 0.55))),
    sidebarRowSelected: themeColor(surfaceAt(dark ? 0.14 : 0.1, Math.min(0.11, accent.C * 0.6))),
    sidebarBorder: themeColor(surfaceAt(dark ? 0.17 : 0.12, Math.min(0.08, accent.C * 0.4))),
    terminalBackground: themeColorOfRgb(canvasRgb),
    terminalForeground: themeColorOfRgb(textRgb),
    terminalCursor: themeColorOfRgb(accentRgb),
    terminalSelection: themeColor(surfaceAt(dark ? 0.18 : 0.12, Math.min(0.12, accent.C * 0.55))),
    terminalScrollbar: themeColor(surfaceAt(dark ? 0.22 : 0.16, tintC)),
    terminalScrollbarHover: themeColor(surfaceAt(dark ? 0.3 : 0.22, tintC)),
  };
}

/** Sets one role in the advanced editor and rewrites the roles that follow it (updateThemeColorFamily). */
export function updateThemeColorFamily(appearance: ThemeAppearance, colors: ThemeColors, role: ThemeColorRole, value: string): ThemeColors {
  const parsedSelected = parseThemeColor(value);
  if (!parsedSelected) return { ...colors, [role]: value };
  const normalized = themeColorToHex(value)!;

  const canvas = rgbOf(colors.canvas, appearance === "dark" ? { r: 24, g: 15, b: 27 } : { r: 250, g: 245, b: 250 });
  const selected = oklchToRgb(parsedSelected.color);
  const selectedOn = (background: Rgb) => mixRgb(background, selected, parsedSelected.alpha);
  const selectedOnCanvas = selectedOn(canvas);
  const accent = rgbOf(colors.accent, { r: 168, g: 67, b: 112 });
  const canvasIsDark = relativeLuminance(canvas) < 0.179;
  const terminalIsDark = relativeLuminance(selectedOnCanvas) < 0.179;
  const colorOf = (color: Rgb) => themeColorOfRgb(color);
  const foregroundOn = (background: Rgb) => colorOf(readableForeground(background));
  const selectedToneOn = (background: Rgb) =>
    themeColorOfOklch(solveLightness(parsedSelected.color, [background], 4.6, relativeLuminance(background) < 0.179 ? "lighter" : "darker"));
  const statusColors = () => {
    const surface = mixRgb(canvas, selectedOnCanvas, canvasIsDark ? 0.16 : 0.08);
    return { foreground: selectedToneOn(surface), surface: colorOf(surface) };
  };

  switch (role) {
    case "canvas":
      return { ...colors, canvas: normalized, chrome: normalized, toolbar: normalized };
    case "surface":
    case "surfaceRaised":
    case "surfaceOverlay":
    case "input":
    case "sidebarControlSurface":
      return { ...colors, [role]: normalized };
    case "text":
      return { ...colors, text: normalized, toolbarForeground: normalized, toolbarControlForeground: normalized };
    case "mutedForeground":
      return { ...colors, textMuted: normalized, mutedForeground: normalized, placeholder: normalized, secondaryLabel: normalized, iconMuted: normalized, sidebarMutedForeground: normalized };
    case "border":
      return { ...colors, border: normalized, toolbarBorder: normalized, sidebarBorder: normalized };
    case "secondary":
      return { ...colors, secondary: normalized, secondaryForeground: foregroundOn(selectedOnCanvas), muted: normalized, toolbarControl: normalized };
    case "accentSurface":
      return { ...colors, accentSurface: normalized, accentSurfaceForeground: foregroundOn(selectedOnCanvas), toolbarControlHover: normalized };
    case "accent": {
      const updateSurface = mixRgb(canvas, selectedOnCanvas, canvasIsDark ? 0.32 : 0.16);
      return {
        ...colors, accent: normalized, accentForeground: foregroundOn(selectedOnCanvas), focus: normalized, update: normalized,
        updateForeground: selectedToneOn(updateSurface), updateSurface: colorOf(updateSurface), terminalCursor: normalized,
      };
    }
    case "messageAction": {
      const actionForeground = readableForeground(selectedOnCanvas);
      const towardOpposite = actionForeground === LIGHT_FOREGROUND || actionForeground === WHITE ? BLACK : WHITE;
      const actionHover = mixRgb(selected, towardOpposite, 0.12);
      return {
        ...colors, messageAction: normalized, messageActionForeground: colorOf(actionForeground),
        messageActionHover: parsedSelected.alpha >= 1 ? colorOf(actionHover) : `${colorOf(actionHover)}${hexPair(parsedSelected.alpha * 255)}`,
      };
    }
    case "messageSurface":
      return { ...colors, messageSurface: normalized, messageForeground: foregroundOn(selectedOnCanvas) };
    case "searchMatchBackground":
      return { ...colors, searchMatchBackground: colorOf(selectedOnCanvas), searchMatchForeground: foregroundOn(selectedOnCanvas) };
    case "searchMatchActiveBackground":
      return { ...colors, searchMatchActiveBackground: colorOf(selectedOnCanvas), searchMatchActiveForeground: foregroundOn(selectedOnCanvas) };
    case "codeBackground":
      return { ...colors, codeBackground: normalized, codeForeground: foregroundOn(selectedOnCanvas) };
    case "sidebar":
      return { ...colors, sidebar: normalized, sidebarForeground: foregroundOn(selectedOnCanvas) };
    case "sidebarRowSelected": {
      const sidebar = rgbOf(colors.sidebar, canvas);
      const selectedOnSidebar = selectedOn(sidebar);
      return {
        ...colors,
        sidebarRowHover: colorOf(mixRgb(sidebar, selectedOnSidebar, 0.5)),
        sidebarRowActive: colorOf(mixRgb(sidebar, selectedOnSidebar, 0.8)),
        sidebarRowSelected: normalized,
      };
    }
    case "terminalBackground": {
      const terminalForeground = readableForeground(selectedOnCanvas);
      return {
        ...colors,
        terminalBackground: normalized,
        terminalForeground: colorOf(terminalForeground),
        terminalSelection: colorOf(mixRgb(selectedOnCanvas, accent, terminalIsDark ? 0.35 : 0.18)),
        terminalScrollbar: colorOf(mixRgb(selectedOnCanvas, terminalForeground, terminalIsDark ? 0.42 : 0.22)),
        terminalScrollbarHover: colorOf(mixRgb(selectedOnCanvas, terminalForeground, terminalIsDark ? 0.55 : 0.32)),
      };
    }
    case "error": {
      const status = statusColors();
      return { ...colors, error: normalized, errorForeground: status.foreground, errorSurface: status.surface };
    }
    case "warning": {
      const status = statusColors();
      return { ...colors, warning: normalized, warningForeground: status.foreground, warningSurface: status.surface };
    }
    default:
      return { ...colors, [role]: normalized };
  }
}
