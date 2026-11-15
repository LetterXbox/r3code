// What each setting is, where it lives and what it defaults to, derived from the
// generated panels and their resolved controls. A client setting is kept on this
// device as an override of its default; a server setting belongs to the server
// (`server.updateSettings`) and must never be read from, or written to, the local
// blob. Scope follows the web's splitPatch (hooks/useSettings.ts): a key of
// ServerSettings is a server key, anything else is a client key.
//
// This module imports nothing from store.ts (store.ts imports it).
import { SETTINGS_PANELS } from "../../settingsPanels";
import { isRestorableThemeId } from "./builtTheme";
import { resolveControl } from "./controlSpecs";

export type SettingValue = string | boolean | number;

interface SettingMeta {
  scope: "client" | "server";
  default: SettingValue | null;
  /** The values a select can produce; null when the setting is not a select. */
  options: string[] | null;
}

/** ServerSettings keys the panels have no row for (contracts settings.ts). */
const EXTRA_SERVER_FIELDS = ["defaultRuntimeMode"];

/**
 * Client settings drawn by a bespoke control rather than a generated row, with the default the
 * contracts ship. A structured value is kept as JSON text (DEFAULT_BROWSER_VIEWPORT is
 * `{ _tag: "fill" }`); the microphone is a device id, "" for the system default.
 */
const JSON_CLIENT_DEFAULTS: Record<string, string> = { browserDefaultViewport: '{"_tag":"fill"}', voiceMicrophone: "" };

const meta = new Map<string, SettingMeta>();

function build() {
  for (const [field, value] of Object.entries(JSON_CLIENT_DEFAULTS)) meta.set(field, { scope: "client", default: value, options: null });
  for (const panel of SETTINGS_PANELS) {
    for (const section of panel.sections) {
      for (const row of section.rows) {
        const spec = resolveControl(row);
        if (spec) {
          // A nested server value (worktreeCleanup) is edited through several rows; the first wins.
          if (meta.has(spec.field)) continue;
          const options = spec.kind === "select" ? spec.options.map((o) => o.value)
            : spec.field === "sidebarProjectGroupingMode" ? (row.options ?? []).map((o) => o.value) : null;
          meta.set(spec.field, { scope: spec.scope, default: spec.fallback, options });
        } else if (row.field && (row.scope === "client" || row.scope === "server") && !meta.has(row.field)) {
          meta.set(row.field, { scope: row.scope, default: null, options: null });
        }
      }
    }
  }
  for (const field of EXTRA_SERVER_FIELDS) if (!meta.has(field)) meta.set(field, { scope: "server", default: null, options: null });
}
build();

/** Whether the generated panels (or the server key list) know this field. */
export function hasSetting(field: string): boolean {
  return meta.has(field);
}

/** "server" for a ServerSettings key, otherwise "client" (the web's splitPatch). */
export function scopeOfSetting(field: string): "client" | "server" {
  return meta.get(field)?.scope ?? "client";
}

/** The shipped default of a setting, or undefined when it has none a client can seed. */
export function defaultOfSetting(field: string): SettingValue | undefined {
  const value = meta.get(field)?.default;
  return value === null || value === undefined ? undefined : value;
}

/** Every client setting that has a shipped default. */
export function clientDefaults(): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const [field, m] of meta) if (m.scope === "client" && m.default !== null) out[field] = m.default;
  return out;
}

/**
 * Whether a saved value may be restored: a server key never comes from the local blob, and a
 * select value must be one of the row's options (a stale value no control can produce would
 * leave the select blank).
 */
export function acceptsSavedSetting(field: string, value: SettingValue): boolean {
  // A client that cannot switch themes at runtime must not present an older build's saved pick as active.
  if (field === "themeLight" || field === "themeDark") return isRestorableThemeId(value);
  const m = meta.get(field);
  if (!m) return true;
  if (m.scope === "server") return false;
  if (m.options && !m.options.includes(String(value))) return false;
  return true;
}

/** The saved settings worth restoring, each with the type of its field's default. */
export function validSavedValues(
  saved: Record<string, unknown>,
  defaults: Record<string, SettingValue>,
  accepts: (field: string, value: SettingValue) => boolean = acceptsSavedSetting,
): Record<string, SettingValue> {
  const valid: Record<string, SettingValue> = {};
  for (const [key, value] of Object.entries(saved)) {
    if (typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number") continue;
    if (key in defaults && typeof defaults[key] !== typeof value) continue;
    if (!accepts(key, value)) continue;
    // A value equal to its default is not an override; dropping it lets a later change of the default reach this user.
    if (key in defaults && defaults[key] === value) continue;
    valid[key] = value;
  }
  return valid;
}

/** What to persist: only the values that differ from their default. */
export function settingOverrides(values: Record<string, SettingValue>, defaults: Record<string, SettingValue>): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const [key, value] of Object.entries(values)) if (!(key in defaults) || defaults[key] !== value) out[key] = value;
  return out;
}
