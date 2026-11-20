// The connected environment's published themes (themePalette.ts publishedThemeDefinitions / environmentThemeDefinitionsAtom,
// hooks/useEnvironmentTheme.ts) and the adoption of its default theme (hooks/useDefaultTheme.ts). The server sends the
// palettes in the config snapshot (`environmentThemes`) and republishes them with `environmentThemesUpdated`; they are
// not saved, since they go stale the moment the machine's theme moves on. A published theme reads like a custom one
// (`CustomTheme` shape) everywhere a theme id is looked up, after the built-in and saved themes.
import { effect, signal, Storage, untracked } from "nsh";
import type { CustomTheme } from "./customThemes";
import { isReservedThemeId } from "./themeFile";
import { createVividThemeColors, getDefaultThemeColors, getThemeModes, singleAppearanceOf, THEME_COLOR_ROLES, toCanonicalThemeColor, type ThemeAppearance, type ThemeColors } from "./themePalette";

type Dict = Record<string, unknown>;
const dict = (value: unknown): Dict | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dict) : null);
const ROLES = new Set<string>(THEME_COLOR_ROLES as readonly string[]);

export interface PublishedTheme extends CustomTheme {
  background?: string;
}

/** lenientThemeColorOverrides: the known roles with a colour this client can parse, canonical hex. */
function lenientOverrides(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [role, color] of Object.entries(dict(value) ?? {})) {
    const normalized = typeof color === "string" ? toCanonicalThemeColor(color) : null;
    if (ROLES.has(role) && normalized) out[role] = normalized;
  }
  return out;
}

const appearanceOf = (value: unknown): ThemeAppearance | null => (value === "light" || value === "dark" ? value : null);

/** publishedThemeColors: a variant builds on its appearance's stock defaults; the main palette on the canvas/accent seeds when given. */
function publishedColors(theme: Dict, appearance: ThemeAppearance, own: ThemeAppearance, colors: unknown): ThemeColors {
  const canvas = typeof theme.canvas === "string" ? theme.canvas : undefined;
  const accent = typeof theme.accent === "string" ? theme.accent : undefined;
  const base = appearance === own && canvas !== undefined && accent !== undefined ? createVividThemeColors(appearance, canvas, accent) : getDefaultThemeColors(appearance);
  return { ...base, ...lenientOverrides(colors) } as ThemeColors;
}

/** publishedThemeDefinitions: the palettes this client can render; reserved ids are dropped (they would capture a built-in). */
export function publishedThemeDefinitions(raw: unknown): PublishedTheme[] {
  if (!Array.isArray(raw)) return [];
  const out: PublishedTheme[] = [];
  for (const entry of raw) {
    const theme = dict(entry);
    const appearance = appearanceOf(theme?.appearance);
    if (!theme || !appearance || typeof theme.id !== "string" || typeof theme.name !== "string" || isReservedThemeId(theme.id)) continue;
    const seeded = theme.canvas !== undefined && theme.accent !== undefined;
    const other: ThemeAppearance = appearance === "dark" ? "light" : "dark";
    const variantsIn = dict(theme.variants) ?? {};
    if (!seeded && ![theme.colors, variantsIn[other]].some((colors) => colors !== undefined && Object.keys(lenientOverrides(colors)).length > 0)) continue;
    const variants: Partial<Record<ThemeAppearance, Record<string, string>>> = {};
    for (const [mode, colors] of Object.entries(variantsIn)) {
      const variant = appearanceOf(mode);
      if (!variant || variant === appearance) continue;
      variants[variant] = publishedColors(theme, variant, appearance, colors) as unknown as Record<string, string>;
    }
    out.push({
      id: theme.id,
      label: theme.name,
      appearance,
      ...(typeof theme.background === "string" && theme.background.length > 0 && theme.background.length <= 64
        ? { background: theme.background }
        : {}),
      colors: publishedColors(theme, appearance, appearance, theme.colors) as unknown as Record<string, string>,
      ...(Object.keys(variants).length > 0 ? { variants } : {}),
      // Only the pure seeded form is guided-generator output.
      ...(seeded && theme.colors === undefined && theme.variants === undefined ? { managed: true } : {}),
    });
  }
  return out;
}

const published = signal<PublishedTheme[]>([]);
let publishedKey = "[]";

/** The environment's palettes (useEnvironmentThemeDefinitions). */
export const environmentThemes = () => published();
export const environmentThemeById = (id: string): PublishedTheme | null => published().find((theme) => theme.id === id) ?? null;

/** Takes a published set; an identical one (every reconnect snapshot) keeps the previous array, so nothing repaints. */
export function setEnvironmentThemes(raw: unknown) {
  const next = publishedThemeDefinitions(raw);
  const key = JSON.stringify(next);
  if (key === publishedKey) return;
  publishedKey = key;
  published.set(next);
}

/** Feeds a config stream event: the snapshot's `environmentThemes`, or an `environmentThemesUpdated` payload. */
export function observeEnvironmentThemesEvent(event: unknown) {
  const value = dict(event);
  if (!value) return;
  if (value.type === "snapshot") setEnvironmentThemes(dict(value.config)?.environmentThemes ?? []);
  else if (value.type === "environmentThemesUpdated") setEnvironmentThemes(dict(value.payload)?.themes ?? []);
}

export const APPLIED_DEFAULT_THEME_STORAGE_PREFIX = "t3code:default-theme-applied:v2:";

/** defaultThemeGeneration: the set time is part of it, so reasserting the same theme still applies. */
export function defaultThemeGeneration(theme: string, setAt: string): string {
  return setAt.length > 0 ? `${theme}@${setAt}` : theme;
}

/** defaultThemeToApply: the generation to adopt now, or null (no environment, no default, already adopted, not resolvable yet). */
export function defaultThemeToApply(input: { environmentId: string | null; defaultTheme: string; defaultThemeSetAt: string; appliedGeneration: string | null; resolves: boolean }): string | null {
  if (input.environmentId === null || input.defaultTheme.length === 0) return null;
  const generation = defaultThemeGeneration(input.defaultTheme, input.defaultThemeSetAt);
  if (input.appliedGeneration === generation) return null;
  if (!input.resolves) return null;
  return generation;
}

export interface DefaultThemeDeps {
  environmentId: () => string | null;
  settings: () => Dict | null;
  /** The theme's modes when the id resolves (built-in, saved or published), else null. */
  modesOf: (id: string) => ThemeAppearance[] | null;
  /** setTheme / assignHalf: puts the theme on these appearances. */
  apply: (id: string, modes: ThemeAppearance[]) => void;
  /** setAppearanceMode, for a single-appearance theme. */
  setAppearance: (mode: ThemeAppearance) => void;
  read?: (key: string) => Promise<string | null>;
  write?: (key: string, value: string) => Promise<void>;
}

/**
 * startDefaultThemeAdoption: applies the environment's default theme once per generation, re-checking when the
 * environment, its settings or the published / saved palettes change, so a theme that resolves late still applies.
 */
export function startDefaultThemeAdoption(deps: DefaultThemeDeps) {
  const read = deps.read ?? ((key: string) => Storage.getItem(key));
  const write = deps.write ?? ((key: string, value: string) => Storage.setItem(key, value));
  const applied = new Map<string, string | null>();
  let pending = false;
  effect(() => {
    const environmentId = deps.environmentId();
    const settings = deps.settings();
    void published();
    const defaultTheme = typeof settings?.defaultTheme === "string" ? settings.defaultTheme : "";
    const setAt = typeof settings?.defaultThemeSetAt === "string" ? settings.defaultThemeSetAt : "";
    const modes = untracked(() => (defaultTheme ? deps.modesOf(defaultTheme) : null));
    if (environmentId === null || !defaultTheme || pending) return;
    const key = `${APPLIED_DEFAULT_THEME_STORAGE_PREFIX}${environmentId}`;
    const adopt = (appliedGeneration: string | null) => {
      const generation = defaultThemeToApply({ environmentId, defaultTheme, defaultThemeSetAt: setAt, appliedGeneration, resolves: modes !== null });
      if (generation === null || modes === null) return;
      deps.apply(defaultTheme, modes);
      if (modes.length === 1) deps.setAppearance(modes[0]!);
      applied.set(key, generation);
      void write(key, generation).catch(() => {});
    };
    if (applied.has(key)) { adopt(applied.get(key) ?? null); return; }
    pending = true;
    void read(key).then((value) => value, () => null).then((value) => {
      pending = false;
      if (!applied.has(key)) applied.set(key, value ?? null);
      untracked(() => adopt(applied.get(key) ?? null));
    });
  });
}

/** The modes of a published theme (singleAppearanceOf / getThemeModes on its definition). */
export function environmentThemeModes(theme: CustomTheme): ThemeAppearance[] {
  const definition = { id: theme.id, label: theme.label, appearance: theme.appearance, colors: theme.colors as unknown as ThemeColors, ...(theme.variants ? { variants: theme.variants as never } : {}) };
  const single = singleAppearanceOf(definition as never);
  return single ? [single] : getThemeModes(definition as never);
}
