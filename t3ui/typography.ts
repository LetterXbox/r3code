// The typography settings (Appearance > Typography) as the styles the app paints with: the interface
// family and size for the whole shell, and the prompt, code and terminal ones for the surfaces that
// show them. The web writes CSS variables on <html> and every rem follows; here the shell root
// carries the interface family and size as an inheriting text style, so any text that does not set its
// own family follows it, and a surface that shows code spreads `codeTextStyle()` on its text.
import { settingValue } from "./store";
import { appZoomFactor, zoomedSize } from "./shell/appZoom";

export const FONT_DEFAULTS = { interface: 16, prompt: 14, code: 13, terminal: 12 } as const;
export const FONT_LIMITS = { interface: [12, 20], prompt: [12, 20], code: [10, 18], terminal: [8, 20] } as const;
/** The pixel size of un-sized text in this app (Tailwind `text-sm`), which the interface size scales. */
const BASE_TEXT_SIZE = 14;
const DEFAULT_SANS_FONT_STACK = '-apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", system-ui, sans-serif';
const DEFAULT_CODE_FONT_STACK = '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';

export type FontKind = keyof typeof FONT_DEFAULTS;
const FAMILY_FIELD: Record<FontKind, string> = { interface: "fontFamilySans", prompt: "fontFamilyComposer", code: "fontFamilyCode", terminal: "fontFamilyTerminal" };
const SIZE_FIELD: Record<FontKind, string> = { interface: "fontSizeInterface", prompt: "fontSizePrompt", code: "fontSizeCode", terminal: "fontSizeTerminal" };

export const familyField = (kind: FontKind) => FAMILY_FIELD[kind];
export const sizeField = (kind: FontKind) => SIZE_FIELD[kind];

/** `"Fira Code"` or `Fira Code, monospace` to a CSS family list; null when empty (cssFontFamilies). */
export function cssFontFamilies(value: string): string | null {
  const names = value.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
  if (names.length === 0) return null;
  return names.map((name) => (/^(['"]).*\1$/.test(name) || /^[a-zA-Z][a-zA-Z0-9-]*$/.test(name) ? name : `"${name.replaceAll('"', "")}"`)).join(", ");
}

export function clampFontSize(kind: FontKind, value: unknown): number {
  const [min, max] = FONT_LIMITS[kind];
  const number = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : FONT_DEFAULTS[kind];
  return Math.min(max, Math.max(min, number));
}

export function fontFamilySetting(kind: FontKind): string {
  const value = settingValue(FAMILY_FIELD[kind]);
  return typeof value === "string" ? value.trim() : "";
}

export function fontSizeSetting(kind: FontKind): number {
  return clampFontSize(kind, settingValue(SIZE_FIELD[kind]));
}

/** "Separate fonts" off: the terminal follows the code font, and the prompt the interface font. */
export function separateFonts(): boolean {
  return settingValue("typographyAdvanced") === true;
}

/** The family that paints `kind` (code's and terminal's fall back to the monospace stack), with the fallback list the web appends. */
export function resolvedFamily(kind: FontKind): string {
  const separate = separateFonts();
  const pick = (custom: string, fallback: string) => {
    const list = cssFontFamilies(custom);
    return list === null ? fallback : `${list}, ${fallback}`;
  };
  switch (kind) {
    case "interface": return pick(fontFamilySetting("interface"), DEFAULT_SANS_FONT_STACK);
    case "prompt": return pick(separate ? fontFamilySetting("prompt") : "", pick(fontFamilySetting("interface"), DEFAULT_SANS_FONT_STACK));
    case "code": return pick(fontFamilySetting("code"), DEFAULT_CODE_FONT_STACK);
    case "terminal": return pick(separate ? fontFamilySetting("terminal") : fontFamilySetting("code"), DEFAULT_CODE_FONT_STACK);
  }
}

/** The size the settings give `kind`, times the app zoom (shell/appZoom.ts). */
export function resolvedSize(kind: FontKind): number {
  return zoomedSize(unzoomedSize(kind));
}

function unzoomedSize(kind: FontKind): number {
  if (!separateFonts()) {
    if (kind === "terminal") return fontSizeSetting("code");
    if (kind === "prompt") return fontSizeSetting("interface") === FONT_DEFAULTS.interface ? FONT_DEFAULTS.prompt : Math.round(FONT_DEFAULTS.prompt * fontSizeSetting("interface") / FONT_DEFAULTS.interface);
  }
  return fontSizeSetting(kind);
}

/** The inheriting style of the shell root: the interface family always (when the user set one), the size when it is not the default. */
export function rootTextStyle(): { fontFamily?: string; fontSize?: number } {
  const style: { fontFamily?: string; fontSize?: number } = {};
  if (cssFontFamilies(fontFamilySetting("interface")) !== null) style.fontFamily = resolvedFamily("interface");
  const size = fontSizeSetting("interface");
  const zoom = appZoomFactor();
  if (size !== FONT_DEFAULTS.interface || zoom !== 1) style.fontSize = Math.max(1, Math.round(BASE_TEXT_SIZE * size * zoom / FONT_DEFAULTS.interface));
  return style;
}

/** Spread on the text of a surface that shows code (diffs, file previews, code blocks). */
export const codeTextStyle = () => ({ fontFamily: resolvedFamily("code"), fontSize: resolvedSize("code") });
/** The composer's text. */
export const promptTextStyle = () => ({ fontFamily: resolvedFamily("prompt"), fontSize: resolvedSize("prompt") });
/** The terminal's text. */
export const terminalTextStyle = () => ({ fontFamily: resolvedFamily("terminal"), fontSize: resolvedSize("terminal") });
