// Environment identification (AppearanceSettingsPanel.tsx, SidebarStageBackdrop.tsx, hooks/useSettings.ts): how the sidebar says
// which build it is, as the stage's artwork, the other stage's artwork, a version pill or nothing.
//
// The web's stage is its build channel (APP_STAGE_LABEL: Latest, Nightly or Dev) unless the connected server's version says
// Nightly. This app is a development build of the port and has no channel of its own, so its stage is Dev; the default mode,
// `artwork`, therefore draws the Dev blueprint behind the sidebar header, which is what this app has always drawn. A server on
// a nightly version makes the stage Nightly, as in the web.
import { settingValue } from "../../store";
import { builtThemeForMode } from "./builtTheme";
import { serverEnvironment } from "./settingsState";
import { themeAllowsSidebarArtwork } from "./themePalette";
import { colorScheme } from "nsh";

export type EnvironmentIdentificationMode = "artwork" | "nightly-artwork" | "dev-artwork" | "pill" | "none";
export type StageVariant = "nightly" | "dev";

export const DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE: EnvironmentIdentificationMode = "artwork";
const MODES: ReadonlyArray<string> = ["artwork", "nightly-artwork", "dev-artwork", "pill", "none"];
const NIGHTLY_SERVER_VERSION_PATTERN = /^[^-+]+-(?:nightly|preview)\.\d{8}\.\d+$/;
/** The port's own channel. */
export const APP_STAGE_LABEL = "Dev";

export const ENVIRONMENT_IDENTIFICATION_LABELS: Record<EnvironmentIdentificationMode, string> = {
  artwork: "Artwork", "nightly-artwork": "Nightly artwork", "dev-artwork": "Dev artwork", pill: "Version pill", none: "None",
};

/** resolveServerBackedAppStageLabel */
export function resolveStageLabel(serverVersion: string | null | undefined, fallback: string = APP_STAGE_LABEL): string {
  return serverVersion && NIGHTLY_SERVER_VERSION_PATTERN.test(serverVersion) ? "Nightly" : fallback;
}

export function stageLabel(): string {
  const version = serverEnvironment()?.serverVersion;
  return resolveStageLabel(typeof version === "string" ? version : null);
}

/** resolveSidebarStageBackdropVariant */
export function resolveSidebarStageBackdropVariant(label: string, mode: EnvironmentIdentificationMode = "artwork"): StageVariant | null {
  if (mode === "nightly-artwork") return "nightly";
  if (mode === "dev-artwork") return "dev";
  if (mode !== "artwork") return null;
  const normalized = label.trim().toLowerCase();
  return normalized === "nightly" ? "nightly" : normalized === "dev" ? "dev" : null;
}

/** The pill's text for a stage (resolveEnvironmentIdentificationPillLabel). */
export function resolvePillLabel(label: string): "Dev" | "Nightly" | null {
  const normalized = label.trim().toLowerCase();
  return normalized === "dev" ? "Dev" : normalized === "nightly" ? "Nightly" : null;
}

/** environmentIdentificationOptions: the default `artwork` is labelled as the running stage's own art (None on Latest). */
export function environmentIdentificationOptions(stage: StageVariant | null): ReadonlyArray<{ value: EnvironmentIdentificationMode; label: string }> {
  const rows: ReadonlyArray<readonly [EnvironmentIdentificationMode, string]> =
    stage === "dev"
      ? [["artwork", "Dev artwork"], ["nightly-artwork", "Nightly artwork"], ["pill", "Version pill"], ["none", "None"]]
      : stage === "nightly"
        ? [["artwork", "Nightly artwork"], ["dev-artwork", "Dev artwork"], ["pill", "Version pill"], ["none", "None"]]
        : [["artwork", "None"], ["nightly-artwork", "Nightly artwork"], ["dev-artwork", "Dev artwork"]];
  return rows.map(([value, label]) => ({ value, label }));
}

/** The saved mode (an unknown value is the default). */
export function savedMode(): EnvironmentIdentificationMode {
  const value = settingValue("environmentIdentificationMode");
  return typeof value === "string" && MODES.includes(value) ? (value as EnvironmentIdentificationMode) : DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE;
}

/** The theme the window is painted in for the current scheme. */
function paintedThemeId(): string {
  return builtThemeForMode(colorScheme() === "light" ? "light" : "dark");
}

/** useEnvironmentIdentificationMode: only built-in themes show artwork, so any other theme turns an artwork mode into the pill. */
export function resolveEffectiveMode(mode: EnvironmentIdentificationMode, themeId: string): EnvironmentIdentificationMode {
  const artwork = mode !== "pill" && mode !== "none";
  // The standard T3 Code theme paints the artwork too: it is the app's own, not a palette theme.
  const palette = themeId !== "default";
  return palette && !themeAllowsSidebarArtwork(themeId) && artwork ? "pill" : mode;
}

export const effectiveMode = (): EnvironmentIdentificationMode => resolveEffectiveMode(savedMode(), paintedThemeId());
export const sidebarBackdropVariant = (): StageVariant | null => resolveSidebarStageBackdropVariant(stageLabel(), effectiveMode());
export const sidebarPillLabel = (): "Dev" | "Nightly" | null => (effectiveMode() === "pill" ? resolvePillLabel(stageLabel()) : null);

/** The row's description (environmentIdentificationDescription). */
export function environmentIdentificationDescription(): string {
  const stage = resolveSidebarStageBackdropVariant(stageLabel());
  const hidesArtwork = effectiveMode() === "pill" && resolveSidebarStageBackdropVariant(stageLabel(), savedMode()) !== null;
  if (hidesArtwork) return stage ? "Only built-in themes show artwork, so this theme shows the version pill." : "Only built-in themes show artwork.";
  return stage ? "Choose how Dev and Nightly environments are identified." : "Show Dev or Nightly artwork in the sidebar header.";
}
