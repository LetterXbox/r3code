// The theme this build of the app is painted in. NSH fixes the palette (t3ui/theme.json) when the bundle
// is built, so a plain rebuild-and-restart window can only show the theme it was built with; a host with
// the `theme.setOverrides` capability (third_party/nsh-host/README.md "live theme") can repaint the running
// window instead, through themeRequest.ts, which calls `setBuiltTheme` once it has applied: "which theme is
// showing" is a signal (not a plain variable) for exactly that, so the selection rings and anything else
// reading it (themeSelection.ts, environmentIdentification.ts) follow a live apply at once, the same as a
// themed rebuild's T3GPUI_BUILT_THEME naming what it built: {"light": id, "dark": id, "contrast": n},
// written by tools/build_theme.py. Without either (a plain `nsh run`, the tests) the app is the checked-in
// default, Ocean at contrast 100. Kept free of store/settings imports so settingsDefaults.ts (which store.ts
// imports) can read it; importing "nsh" itself is fine, every module does.
import { signal } from "nsh";

/** The default theme: what t3ui/theme.json holds and what an app with no theme request shows. */
export const BUILT_THEME_ID = "ocean";
export const DEFAULT_CONTRAST = 100;
export const MIN_CONTRAST = 50;
export const MAX_CONTRAST = 200;
export const BUILT_THEME_ENV = "T3GPUI_BUILT_THEME";

export interface BuiltTheme { light: string; dark: string; contrast: number }

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const DEFAULTS: BuiltTheme = { light: BUILT_THEME_ID, dark: BUILT_THEME_ID, contrast: DEFAULT_CONTRAST };

/** Reads the launcher's description of the bundle; anything unusable is the default. */
export function parseBuiltTheme(text: string | undefined): BuiltTheme | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const { light, dark, contrast } = value as Record<string, unknown>;
    if (typeof light !== "string" || typeof dark !== "string" || !ID.test(light) || !ID.test(dark)) return null;
    if (typeof contrast !== "number" || !Number.isInteger(contrast) || contrast < MIN_CONTRAST || contrast > MAX_CONTRAST) return null;
    return { light, dark, contrast };
  } catch {
    return null;
  }
}

function readBuilt(): BuiltTheme | null {
  try {
    return parseBuiltTheme(process.env[BUILT_THEME_ENV]);
  } catch {
    return null;
  }
}

const built = signal<BuiltTheme | null>(readBuilt());

/** Whether this window was started by the launcher with a theme-aware build, so a request can be answered. */
export const themeRebuildAvailable = () => built() !== null;
export const builtTheme = (): BuiltTheme => built() ?? DEFAULTS;
export const builtThemeForMode = (mode: "light" | "dark"): string => builtTheme()[mode];
export const builtContrast = (): number => builtTheme().contrast;

/** Sets what this window is now showing: a live apply (themeRequest.ts, once the host has applied the
 * override) or a test pretending the bundle was built with this theme (null: the default build). Reactive:
 * anything reading `builtTheme` / `builtThemeForMode` / `builtContrast` follows it at once. */
export function setBuiltTheme(next: BuiltTheme | null) {
  built.set(next);
}

/** Whether a saved themeLight / themeDark value may be restored: any well-formed theme id (a built-in card
 * or a custom theme; one that no longer exists falls back to the built theme where it is read). */
export function isRestorableThemeId(value: unknown): boolean {
  return typeof value === "string" && ID.test(value);
}
