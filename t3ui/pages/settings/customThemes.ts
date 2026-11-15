// The custom theme library, ported from themePalette.ts (installCustomTheme, updateCustomTheme,
// replaceCustomThemeCollection, removeCustomThemes, getStoredCustomThemeCollection) and ThemeSettings.tsx. A
// theme is `{ id, label, appearance, colors, variants?, collection?, managed? }`: colours are hex values keyed
// by the web's theme roles (themePalette.ts THEME_COLOR_ROLES), `variants` carries the palette of the other
// appearance and `collection` ties the themes of one community extension together. The file format lives in
// themeFile.ts. The library is kept in device storage, as the web keeps it in localStorage.
import { signal, Storage } from "nsh";
import { environmentThemeById } from "./environmentThemes";
import { THEME_CARDS, type ThemeAppearance, type ThemeCard, type ThemePreviewColors } from "../../themePreviews";
import {
  isReservedThemeId, parseStoredTheme, parseThemeFile, RESERVED_THEME_IDS, serializeThemeFile, themeIdFromName, THEME_FILE_VERSION,
} from "./themeFile";
import {
  BUILT_IN_THEME_DEFINITIONS, getDefaultThemeColors, getStandardThemeColors, getThemeModes, type ThemeColors, type ThemeDefinition,
} from "./themePalette";

export { isReservedThemeId, parseThemeFile, serializeThemeFile, themeIdFromName, THEME_FILE_VERSION };
const STORAGE_KEY = "customThemes";

export interface CustomTheme {
  id: string;
  label: string;
  appearance: ThemeAppearance;
  colors: Record<string, string>;
  /** The palette of the other appearance, when the theme has both. */
  variants?: Partial<Record<ThemeAppearance, Record<string, string>>>;
  /** The community extension (Open VSX) the theme came from; its variants share one card. */
  collection?: { id: string; label: string };
  /** Made in the editor's simple mode: two colours with the rest derived from them. */
  managed?: boolean;
}

/** The roles the preview circles and wireframes draw, in the order the editor lists them. */
export const PREVIEW_ROLES: { role: keyof ThemePreviewColors; label: string }[] = [
  { role: "canvas", label: "Canvas" },
  { role: "sidebar", label: "Sidebar" },
  { role: "surface", label: "Surface" },
  { role: "accentSurface", label: "Accent surface" },
  { role: "accent", label: "Accent" },
  { role: "messageSurface", label: "Message surface" },
  { role: "messageAction", label: "Message action" },
];

const RESERVED_IDS = new Set<string>([...RESERVED_THEME_IDS, ...THEME_CARDS.map((card) => card.id)]);
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** The theme's palette for one appearance as a whole role set (a copy saved before themes carried every role is filled out), null when it has none. */
export function themePalette(theme: CustomTheme, mode: ThemeAppearance): ThemeColors | null {
  const own = mode === theme.appearance ? theme.colors : theme.variants?.[mode];
  return own ? ({ ...getDefaultThemeColors(mode), ...own } as ThemeColors) : null;
}

export const asDefinition = (theme: CustomTheme): ThemeDefinition => ({
  ...theme,
  colors: themePalette(theme, theme.appearance)!,
  variants: Object.fromEntries(Object.keys(theme.variants ?? {}).map((mode) => [mode, themePalette(theme, mode as ThemeAppearance)])) as ThemeDefinition["variants"],
});

const library = signal<CustomTheme[]>([]);
let loaded = false;

export const customThemes = () => library();
export const customThemeById = (id: string) => library().find((theme) => theme.id === id) ?? null;

function persist() {
  void Storage.setItem(STORAGE_KEY, JSON.stringify(library())).catch(() => {});
}

void Storage.getItem(STORAGE_KEY).then((text) => {
  if (loaded || !text) return;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return;
    const stored: CustomTheme[] = [];
    for (const item of parsed) {
      // A damaged entry is dropped, as the web drops one it cannot read.
      const theme = parseStoredTheme(item);
      if (theme) stored.push(theme);
    }
    // What the user did before storage answered wins over the saved copy.
    library.update((current) => [...stored.filter((theme) => !current.some((item) => item.id === theme.id)), ...current]);
  } catch { /* an unreadable copy is ignored */ }
}).catch(() => {}).finally(() => { loaded = true; });

/** Test hook: start from an empty library without touching storage. */
export function resetCustomThemes(next: CustomTheme[] = []) {
  loaded = true;
  library.set(next);
}

export function installCustomTheme(theme: CustomTheme): void {
  if (RESERVED_IDS.has(theme.id)) throw new Error(`The theme id "${theme.id}" is reserved.`);
  if (BUILT_IN_THEME_DEFINITIONS.some((existing) => existing.id === theme.id) || library().some((existing) => existing.id === theme.id)) {
    throw new Error(`A theme named "${theme.label}" is already installed.`);
  }
  library.update((all) => [...all, theme]);
  persist();
}

export function updateCustomTheme(theme: CustomTheme): void {
  if (RESERVED_IDS.has(theme.id)) throw new Error(`The theme id "${theme.id}" is reserved.`);
  if (!library().some((existing) => existing.id === theme.id)) throw new Error(`The theme "${theme.label}" is not installed.`);
  library.update((all) => all.map((existing) => (existing.id === theme.id ? theme : existing)));
  persist();
}

export function removeCustomThemes(ids: string[]): void {
  const gone = new Set(ids);
  if (gone.size === 0) return;
  library.update((all) => all.filter((theme) => !gone.has(theme.id)));
  persist();
}

/** The installed themes of one community extension (getStoredCustomThemeCollection). */
export const customThemeCollection = (collectionId: string): CustomTheme[] => library().filter((theme) => theme.collection?.id === collectionId);

/**
 * Replaces the installed themes of one extension with a fresh import (replaceCustomThemeCollection): variants
 * the extension no longer ships are removed, the rest take the import's colours. `expectedCollection` is what
 * the caller saw before it downloaded: a library that changed meanwhile is not overwritten.
 */
export function replaceCustomThemeCollection(collectionId: string, themes: CustomTheme[], options?: { expectedCollection?: CustomTheme[] }): CustomTheme[] {
  if (themes.length === 0) throw new Error("A theme collection cannot be empty.");
  if (themes.some((theme) => theme.collection?.id !== collectionId) || new Set(themes.map((theme) => theme.id)).size !== themes.length) {
    throw new Error("That theme collection is invalid.");
  }
  const current = library();
  if (options?.expectedCollection && JSON.stringify(current.filter((theme) => theme.collection?.id === collectionId)) !== JSON.stringify(options.expectedCollection)) {
    throw new Error("Your installed themes changed while this package was downloading. Try again.");
  }
  const occupied = new Set([...BUILT_IN_THEME_DEFINITIONS.map((theme) => theme.id), ...current.filter((theme) => theme.collection?.id !== collectionId).map((theme) => theme.id)]);
  const conflict = themes.find((theme) => RESERVED_IDS.has(theme.id) || occupied.has(theme.id));
  if (conflict) throw new Error(`A theme named "${conflict.label}" is already installed.`);
  const next: CustomTheme[] = [];
  let inserted = false;
  for (const theme of current) {
    if (theme.collection?.id !== collectionId) next.push(theme);
    else if (!inserted) { next.push(...themes); inserted = true; }
  }
  if (!inserted) next.push(...themes);
  library.set(next);
  persist();
  return themes;
}

/** An id and label not yet taken: "Ocean copy", then "Ocean copy 2". */
export function copyIdentity(label: string, taken: Iterable<string>): { id: string; label: string } {
  const ids = new Set(taken);
  const base = `${label} copy`.slice(0, 44);
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    const id = themeIdFromName(name);
    if (!ids.has(id) && !RESERVED_IDS.has(id)) return { id, label: name };
  }
}

const PREVIEW_COLORS = (colors: Record<string, string>): ThemePreviewColors => {
  const out = {} as Record<string, string>;
  for (const { role } of PREVIEW_ROLES) out[role] = colors[role] ?? "#000000";
  return out as unknown as ThemePreviewColors;
};

/** The theme as a card: one preview per appearance it has (getThemeCardDefinition), light before dark. */
export function customThemeCard(theme: CustomTheme): ThemeCard {
  const modes = getThemeModes(asDefinition(theme));
  return {
    id: theme.id,
    label: theme.label,
    previews: modes.map((mode) => ({ mode, colors: PREVIEW_COLORS(themePalette(theme, mode)!) })),
  };
}

/** The whole palette of any theme id for one appearance: the standard card, a built-in theme or a custom one. */
export function paletteOfThemeId(id: string, appearance: ThemeAppearance): { appearance: ThemeAppearance; colors: ThemeColors } | null {
  if (id === "default") return { appearance, colors: getStandardThemeColors(appearance) };
  const builtIn = BUILT_IN_THEME_DEFINITIONS.find((theme) => theme.id === id);
  // getThemeDefinition: built-in, then saved, then the environment's published themes.
  const published = customThemeById(id) ?? environmentThemeById(id);
  const definition = builtIn ?? (published ? asDefinition(published) : null);
  if (!definition) return null;
  const mode = getThemeModes(definition).includes(appearance) ? appearance : definition.appearance;
  return { appearance: mode, colors: (mode === definition.appearance ? definition.colors : definition.variants![mode]!) as ThemeColors };
}

/** A new custom theme seeded from any card's palette for one appearance (every role, not just the ones its preview draws). */
export function themeFromCard(card: ThemeCard, appearance: ThemeAppearance, taken: Iterable<string>): CustomTheme {
  const identity = copyIdentity(card.label, taken);
  const palette = paletteOfThemeId(card.id, appearance);
  if (palette) return { ...identity, appearance: palette.appearance, colors: { ...palette.colors } };
  const preview = card.previews.find((item) => item.mode === appearance) ?? card.previews[0]!;
  return { ...identity, appearance: preview.mode, colors: { ...preview.colors } };
}

export function allThemeIds(): string[] {
  return [...THEME_CARDS.map((card) => card.id), ...library().map((theme) => theme.id)];
}

export function normalizeHex(value: string): string | null {
  const text = value.trim();
  const withHash = text.startsWith("#") ? text : `#${text}`;
  return HEX.test(withHash) ? withHash.toLowerCase() : null;
}
