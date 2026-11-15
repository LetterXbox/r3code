// The theme file format (parseThemeFile, serializeThemeFile, themeIdFromName and the id rules of themePalette.ts):
// `{ version: 1, id?, name, appearance, colors, variants?, collection?, managed? }`. Colours are literal CSS colours
// keyed by theme role; a file that names only some roles gets the rest from T3 Chat (getDefaultThemeColors), as the
// web does, and everything is stored as hex (themePalette.ts). Pure: the library that keeps these is customThemes.ts.
import {
  getDefaultThemeColors, isThemeColor, themeColorToHex, THEME_COLOR_ROLES, type ThemeAppearance, type ThemeColorRole, type ThemeColors,
  type ThemeDefinition,
} from "./themePalette";

export const THEME_FILE_VERSION = 1;

/** RESERVED_THEME_IDS (appearance keywords, built-ins, legacy aliases) plus `default`, the standard T3 Code card. */
export const RESERVED_THEME_IDS: ReadonlySet<string> = new Set([
  "system", "light", "dark", "default", "t3-chat", "grove", "ocean", "ember", "iris", "t3-chat-dark", "t3-grove", "t3-ocean", "t3-ember", "t3-iris",
]);

const ROLE_SET: ReadonlySet<string> = new Set(THEME_COLOR_ROLES);

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const isThemeAppearance = (value: unknown): value is ThemeAppearance => value === "light" || value === "dark";
export const isThemeId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,47})$/.test(value);
export const isThemeLabel = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 48;
export const isReservedThemeId = (themeId: string) => RESERVED_THEME_IDS.has(themeId);

export function themeIdFromName(name: string): string {
  const label = name.trim().toLowerCase();
  const normalized = label.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  if (normalized || !label) return normalized || "custom-theme";
  // Names without ASCII letters or digits still need independent, stable ids.
  let hash = 2_166_136_261;
  for (let index = 0; index < label.length; index += 1) {
    hash ^= label.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `theme-${(hash >>> 0).toString(36)}`;
}

export function parseThemeCollection(value: unknown): { id: string; label: string } | undefined {
  return isRecord(value) && typeof value.id === "string" && /^[a-z0-9][a-z0-9.:-]{0,127}$/i.test(value.id) && isThemeLabel(value.label)
    ? { id: value.id, label: value.label.trim() }
    : undefined;
}

function parseColorOverrides(value: unknown): Partial<Record<ThemeColorRole, string>> {
  if (!isRecord(value)) throw new Error("Theme colors must be objects.");
  const overrides: Partial<Record<ThemeColorRole, string>> = {};
  for (const [role, color] of Object.entries(value)) {
    if (!ROLE_SET.has(role)) throw new Error(`"${role}" is not a supported theme color role.`);
    const normalized = themeColorToHex(typeof color === "string" ? color : "");
    if (!normalized) throw new Error(`The color for "${role}" must be a literal CSS color such as oklch(0.62 0.2 280).`);
    overrides[role as ThemeColorRole] = normalized;
  }
  if (Object.keys(overrides).length === 0) throw new Error("Add at least one color role to the theme file.");
  return overrides;
}

/** Reads a theme file's JSON value, with the web's messages for what is wrong with it. */
export function parseThemeFile(value: unknown): ThemeDefinition {
  if (!isRecord(value)) throw new Error("Theme files must contain a JSON object.");
  if (value.version !== THEME_FILE_VERSION) throw new Error(`This theme file uses an unsupported version. Expected ${THEME_FILE_VERSION}.`);
  const { name, appearance, colors: rawColors } = value;
  if (!isThemeLabel(name)) throw new Error("Theme files need a name (48 characters or fewer).");
  if (!isThemeAppearance(appearance)) throw new Error('Theme files need an appearance of "light" or "dark".');
  if (!isRecord(rawColors)) throw new Error("Theme files need a colors object.");
  const id = value.id === undefined ? themeIdFromName(name) : value.id;
  if (!isThemeId(id)) throw new Error("Theme ids may only contain lowercase letters, numbers, and hyphens.");
  if (RESERVED_THEME_IDS.has(id)) throw new Error(`The theme id "${id}" is reserved.`);
  const overrides = parseColorOverrides(rawColors);
  const collection = parseThemeCollection(value.collection);
  if (value.collection !== undefined && !collection) throw new Error("Theme collections need a valid id and label.");
  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) throw new Error("Theme variants must be an object.");
    for (const [variantAppearance, variantColors] of Object.entries(value.variants)) {
      if (!isThemeAppearance(variantAppearance)) throw new Error('Theme variants may only be named "light" or "dark".');
      if (variantAppearance === appearance) throw new Error(`Theme variants must not repeat the base appearance "${appearance}".`);
      variants[variantAppearance] = { ...getDefaultThemeColors(variantAppearance), ...parseColorOverrides(variantColors) };
    }
  }
  return {
    id,
    label: name.trim(),
    appearance,
    colors: { ...getDefaultThemeColors(appearance), ...overrides },
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    ...(collection ? { collection } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  };
}

export function serializeThemeFile(theme: ThemeDefinition): string {
  const file = {
    version: THEME_FILE_VERSION,
    id: theme.id,
    name: theme.label,
    appearance: theme.appearance,
    colors: theme.colors,
    ...(theme.variants ? { variants: theme.variants } : {}),
    ...(theme.collection ? { collection: theme.collection } : {}),
    ...(theme.managed ? { managed: true } : {}),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

// --- stored themes -------------------------------------------------------------------------------------------

function lenientColors(value: unknown, appearance: ThemeAppearance): ThemeColors | null {
  if (!isRecord(value)) return null;
  const colors: Partial<Record<ThemeColorRole, string>> = {};
  for (const [role, color] of Object.entries(value)) {
    const hex = ROLE_SET.has(role) ? themeColorToHex(typeof color === "string" ? color : "") : null;
    if (hex) colors[role as ThemeColorRole] = hex;
  }
  return { ...getDefaultThemeColors(appearance), ...colors };
}

/** A theme as the library saved it. A copy from before themes carried every role (a few hex colours) is filled out the way a file would be. */
export function parseStoredTheme(value: unknown): ThemeDefinition | null {
  if (!isRecord(value)) return null;
  if (!isThemeId(value.id) || RESERVED_THEME_IDS.has(value.id)) return null;
  if (!isThemeLabel(value.label) || !isThemeAppearance(value.appearance)) return null;
  const colors = lenientColors(value.colors, value.appearance);
  if (!colors) return null;
  let variants: Partial<Record<ThemeAppearance, ThemeColors>> | undefined;
  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) return null;
    const next: Partial<Record<ThemeAppearance, ThemeColors>> = {};
    for (const [appearance, variantColors] of Object.entries(value.variants)) {
      if (!isThemeAppearance(appearance)) return null;
      if (appearance === value.appearance) continue;
      const parsed = lenientColors(variantColors, appearance);
      if (!parsed) return null;
      next[appearance] = parsed;
    }
    if (Object.keys(next).length > 0) variants = next;
  }
  const collection = parseThemeCollection(value.collection);
  return {
    id: value.id,
    label: value.label.trim(),
    appearance: value.appearance,
    colors,
    ...(variants ? { variants } : {}),
    ...(collection ? { collection } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  };
}

export { isThemeColor };
