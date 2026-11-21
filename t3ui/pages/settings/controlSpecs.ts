// Turns a generated settings row into something a control can bind to.
//
// settingsPanels.ts is extracted from the web's JSX, so a few rows come out
// wrong or thin: a select with no options, a switch that is really an enum
// (`sidebarProjectGroupingMode`), a number that is really a slider. Those are
// corrected here, once, from the web's own components and contracts
// (packages/contracts/src/settings.ts, preview.ts). Everything else passes
// through as generated.
import type { SettingsPanelRow } from "../../settingsPanels";
import { nativeLanguageName, SUPPORTED_LOCALES, SYSTEM_LANGUAGE } from "../../i18n/locales";

export interface Opt { value: string; label: string }

export interface ResolvedControl {
  kind: "switch" | "select" | "text" | "number" | "retention";
  field: string;
  scope: "client" | "server";
  options: Opt[];
  /** The value the web ships; reset writes this. */
  fallback: string | boolean | number | null;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** Raw stored value to what the control shows. */
  read: (raw: unknown) => string | boolean | number;
  /** What the control produced to what is stored; null means "unset". For a
   * setting nested in a larger server value, `raw` is that whole value and the
   * result is its replacement. */
  write: (next: string | boolean | number, raw: unknown) => string | boolean | number | null;
  /** What a reset writes when it is more than `write(fallback)`. */
  reset?: (raw: unknown) => string | boolean | number | null;
}

const opts = (pairs: [string, string][]): Opt[] => pairs.map(([value, label]) => ({ value, label }));

/** Options the generator could not read (no <SelectItem>s in the row). */
const FIELD_OPTIONS: Record<string, Opt[]> = {
  // SUPPORTED_LOCALES + SYSTEM_LANGUAGE, SettingsPanels.tsx Language row
  language: opts([
    [SYSTEM_LANGUAGE, "System"],
    ...SUPPORTED_LOCALES.map((code) => [code, nativeLanguageName(code)] as [string, string]),
  ]),
  // QUIT_CONFIRMATION_MODE_LABELS, SettingsPanels.tsx
  confirmQuit: opts([["direct", "Direct"], ["hold", "Hold"], ["double-click", "Double press"]]),
  // PreviewAppearancePreference, contracts preview.ts
  browserDefaultAppearance: opts([["system", "System"], ["light", "Light"], ["dark", "Dark"]]),
  // PREVIEW_ZOOM_LEVELS, contracts preview.ts
  browserDefaultZoomFactor: [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]
    .map((z) => ({ value: String(z), label: `${Math.round(z * 100)}%` })),
  // BROWSER_RECORDING_FRAME_RATES, contracts preview.ts
  browserRecordingFrameRate: opts([["30", "30 fps"], ["60", "60 fps"]]),
  // WORKTREE_SUBMODULES_LABELS, BranchToolbar.logic.ts
  worktreeSubmodules: opts([["recursive", "Recursive"], ["top-level", "Top level only"], ["none", "Skip"]]),
  // BackgroundActivityProfile, contracts settings.ts
  backgroundActivityProfile: opts([["balanced", "Balanced"], ["performance", "Performance"], ["battery-saver", "Battery saver"]]),
  // IDLE_COMPACTION_MODES, contracts settings.ts
  idleCompaction: opts([["onReturn", "When you return"], ["beforeCacheExpires", "Before the cache expires (beta)"], ["off", "Never"]]),
};

/** Defaults the generator could not resolve (named constants in the contracts). */
export const FIELD_DEFAULTS: Record<string, string | boolean | number> = {
  browserDefaultAppearance: "system",
  browserAutoShowFloatingPreview: true,
  browserDefaultZoomFactor: 1,
  browserRecordingFrameRate: 30,
  appearanceContrast: 100,
  glassOpacity: 80,
  // R3: panels slide by default (t3code ships 0 = instant). 0 in Settings still turns it off.
  panelAnimationDurationMs: 225,
  confirmQuit: "hold",
  backgroundActivityProfile: "balanced",
  idleCompaction: "onReturn",
  sidebarAutoSettleAfterDays: 7,
};

/** Number rows the web draws as sliders (MIN_/MAX_ constants in settings.ts). */
const SLIDERS: Record<string, { min: number; max: number; step: number; unit: string }> = {
  appearanceContrast: { min: 50, max: 200, step: 5, unit: "%" },
  glassOpacity: { min: 40, max: 100, step: 5, unit: "%" },
  panelAnimationDurationMs: { min: 0, max: 400, step: 25, unit: " ms" },
};

/** Row ids whose field the generator mislabelled. */
const FIELD_OF_ROW: Record<string, string> = {
  "background-activity": "backgroundActivityProfile",
  "dictation-shortcut-mode": "voiceShortcutMode",
};

const MIN_AUTO_SETTLE_DAYS = 1;
const MAX_AUTO_SETTLE_DAYS = 90;

let lastEnabledGrouping = "repository";

// The cleanup rules at the global scope live in one server key, `storageCleanup`
// (StorageCleanupSettings, contracts settings.ts); the Worktrees and Maintenance rows each edit one
// field of it, as StorageSettings.tsx's `update` does (`updateSettings({ storageCleanup: patch })`).
// `worktreeCleanup` (inherit / off / custom) is the per-project override and has no row here.
const STORAGE_DEFAULTS: Record<string, string | boolean | null> = {
  worktreeKeepWhen: "uncommitted-changes", worktreeAfterDays: null, worktreeSettledAfterDays: null,
  worktreeOnMerge: false, worktreeOnDelete: false, worktreeUnchanged: false,
  browserArtifactsAfterDays: null, logsAfterDays: null,
};
/** Retention rows: a day count, or null for off (StorageRetentionDays; settled days may be 0). */
const RETENTION_FIELDS: Record<string, { min: number }> = {
  worktreeAfterDays: { min: 1 }, worktreeSettledAfterDays: { min: 0 }, browserArtifactsAfterDays: { min: 1 }, logsAfterDays: { min: 1 },
};
export const MAX_RETENTION_DAYS = 3650;
/** What a retention control shows when the rule is off. */
export const RETENTION_OFF = "off";
/** The day count a retention switch turns on with (RetentionControl). */
export const RETENTION_ON_DEFAULT = 8;

function storedCleanup(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** The shape of the `storageCleanup` value the server reports: every rule, defaulted as the schema does. */
export function cleanupRule(raw: unknown, field: string): unknown {
  const value = storedCleanup(raw)[field];
  return value === undefined ? STORAGE_DEFAULTS[field] : value;
}

function storageControl(row: SettingsPanelRow, field: string): ResolvedControl | null {
  if (!(field in STORAGE_DEFAULTS)) return null;
  const base = { field: "storageCleanup", scope: "server" as const };
  const write = (next: string | boolean | number, raw: unknown) => ({ ...storedCleanup(raw), [field]: next }) as never;
  const retention = RETENTION_FIELDS[field];
  if (retention) {
    return {
      ...base, kind: "retention", options: [], fallback: RETENTION_OFF, min: retention.min, max: MAX_RETENTION_DAYS, step: 1, unit: " days",
      read: (raw) => { const v = cleanupRule(raw, field); return typeof v === "number" ? v : RETENTION_OFF; },
      write: (next, raw) => ({ ...storedCleanup(raw), [field]: next === RETENTION_OFF ? null : Math.min(MAX_RETENTION_DAYS, Math.max(retention.min, Math.round(Number(next)))) }) as never,
    };
  }
  if (field === "worktreeKeepWhen") {
    const options = (row.options ?? []).map((o) => ({ value: o.value, label: o.label ?? o.value }));
    return { ...base, kind: "select", options, fallback: "uncommitted-changes", read: (raw) => String(cleanupRule(raw, field)), write };
  }
  return { ...base, kind: "switch", options: [], fallback: false, read: (raw) => cleanupRule(raw, field) === true, write };
}

/**
 * Fields the extractor attached to a control that cannot edit them: model
 * selections are objects, the writing style is a nested struct, the viewport
 * is a union, the microphone is a device id. Writing a boolean or a string
 * there would fail the server's schema, so these stay unwired rather than
 * guessing.
 */
const UNWIRED_FIELDS = new Set([
  "browserDefaultViewport", "voiceMicrophone", "speechPostProcessingPrompt",
  "snoozePresets", "backgroundActivity",
]);

// SourceControlWritingStyleSettings (contracts settings.ts): one server struct whose `mode` is a select,
// `followChangeRequestTemplates` a switch and `customInstructions` the textarea under the select.
export const WRITING_STYLE_MODES: Record<string, { label: string; description: string }> = {
  repo_conventions: { label: "Repository conventions", description: "Commit messages and pull request titles and descriptions match each project's history." },
  conventional_commits: { label: "Conventional Commits", description: "Conventional Commit prefixes, with short pull request titles and descriptions." },
  custom: { label: "Custom instructions", description: "Your instructions shape commit messages and pull request titles and descriptions." },
};
const WRITING_STYLE_DEFAULTS = { mode: "repo_conventions", customInstructions: "", followChangeRequestTemplates: true };

/** The server's writing style with every field defaulted, as the schema decodes it. */
export function writingStyleOf(raw: unknown): { mode: string; customInstructions: string; followChangeRequestTemplates: boolean } {
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    mode: typeof value.mode === "string" && value.mode in WRITING_STYLE_MODES ? value.mode : WRITING_STYLE_DEFAULTS.mode,
    customInstructions: typeof value.customInstructions === "string" ? value.customInstructions : WRITING_STYLE_DEFAULTS.customInstructions,
    followChangeRequestTemplates: typeof value.followChangeRequestTemplates === "boolean" ? value.followChangeRequestTemplates : WRITING_STYLE_DEFAULTS.followChangeRequestTemplates,
  };
}

function writingStyleControl(row: SettingsPanelRow): ResolvedControl | null {
  const base = { field: "sourceControlWritingStyle", scope: "server" as const };
  if (row.id === "source-control-writing-style") {
    return {
      ...base, kind: "select", options: Object.entries(WRITING_STYLE_MODES).map(([value, mode]) => ({ value, label: mode.label })),
      fallback: WRITING_STYLE_DEFAULTS.mode,
      read: (raw) => writingStyleOf(raw).mode,
      write: (next, raw) => ({ ...writingStyleOf(raw), mode: String(next) }) as never,
      // The web's reset puts the mode and the instructions back, and leaves the templates switch alone.
      reset: (raw) => ({ ...writingStyleOf(raw), mode: WRITING_STYLE_DEFAULTS.mode, customInstructions: WRITING_STYLE_DEFAULTS.customInstructions }) as never,
    };
  }
  if (row.id === "follow-change-request-templates") {
    return {
      ...base, kind: "switch", options: [], fallback: true,
      read: (raw) => writingStyleOf(raw).followChangeRequestTemplates,
      write: (next, raw) => ({ ...writingStyleOf(raw), followChangeRequestTemplates: Boolean(next) }) as never,
    };
  }
  return null;
}

export function resolveControl(row: SettingsPanelRow): ResolvedControl | null {
  if (row.id === "source-control-writing-style" || row.id === "follow-change-request-templates") return writingStyleControl(row);
  const field = (row.id && FIELD_OF_ROW[row.id]) || row.field;
  if (!field) return null;
  if (UNWIRED_FIELDS.has(field) || field.endsWith("ModelSelection")) return null;
  if (field in STORAGE_DEFAULTS) return storageControl(row, field);
  const scope = row.scope ?? (FIELD_OF_ROW[row.id ?? ""] ? "server" : null);
  if (scope !== "client" && scope !== "server") return null;
  const generated = row.default === null ? undefined : row.control === "switch" ? row.default === "true" : row.control === "number" ? Number(row.default) : row.default;
  const fallback = FIELD_DEFAULTS[field] ?? generated ?? null;
  const base = { field, scope, fallback } as const;
  const passthrough = { read: (raw: unknown) => raw as string | boolean | number, write: (next: string | boolean | number) => next };

  // Project grouping is a 3-way enum drawn as a switch: off means "separate",
  // on restores the last grouping that was on (projectGroupingModeFromToggle).
  if (field === "sidebarProjectGroupingMode") {
    return {
      ...base, kind: "switch", options: [], fallback: "repository",
      read: (raw) => raw !== "separate",
      write: (next, raw) => {
        if (next === true) return lastEnabledGrouping;
        if (typeof raw === "string" && raw !== "separate") lastEnabledGrouping = raw;
        return "separate";
      },
    };
  }
  // Auto-settle after N days: null is "off", otherwise a day count. The web
  // shows a switch and, while on, a days field.
  if (row.id === "auto-settle-inactive-threads") {
    return {
      ...base, kind: "switch", options: [], fallback: 7,
      read: (raw) => typeof raw === "number",
      write: (next) => (next === true ? 7 : null),
    };
  }
  if (row.id === "days-before-auto-settle") {
    return {
      ...base, kind: "number", options: [], fallback: 7, min: MIN_AUTO_SETTLE_DAYS, max: MAX_AUTO_SETTLE_DAYS, step: 1,
      read: (raw) => (typeof raw === "number" ? raw : 7),
      write: (next) => Math.min(MAX_AUTO_SETTLE_DAYS, Math.max(MIN_AUTO_SETTLE_DAYS, Math.round(Number(next)))),
    };
  }
  // The default merge method: null stores "last selected" (PullRequestMergeMethod | null).
  if (field === "pullRequestMergeMethod") {
    return {
      ...base, kind: "select", fallback: null,
      options: (row.options ?? []).map((o) => ({ value: o.value, label: o.label ?? o.value })),
      read: (raw) => (typeof raw === "string" && raw !== "last" ? raw : "last"),
      write: (next) => (next === "last" ? null : String(next)),
    };
  }
  // A boolean field drawn as an expanded/collapsed select (web:
  // `settings.diffFilesCollapsed ? "Collapsed" : "Expanded"`); the generic
  // select read below would otherwise show the raw "true"/"false".
  if (field === "diffFilesCollapsed") {
    return {
      ...base, kind: "select", fallback: "expanded",
      options: (row.options ?? []).map((o) => ({ value: o.value, label: o.label ?? o.value })),
      read: (raw) => (raw === true ? "collapsed" : "expanded"),
      write: (next) => next === "collapsed",
    };
  }
  const slider = SLIDERS[field];
  if (slider) {
    return {
      ...base, kind: "number", options: [], ...slider,
      read: (raw) => (typeof raw === "number" ? raw : Number(fallback)),
      write: (next) => Math.min(slider.max, Math.max(slider.min, Math.round(Number(next)))),
    };
  }
  if (row.control === "switch") {
    return { ...base, kind: "switch", options: [], read: (raw) => raw === true, write: (next) => Boolean(next) };
  }
  if (row.control === "select") {
    let options: Opt[] = FIELD_OPTIONS[field] ?? (row.options ?? []).map((o) => ({ value: o.value, label: o.label ?? o.value }));
    // The server does not yet order projects by hand in this client.
    if (field === "sidebarProjectSortOrder") options = options.filter((o) => o.value !== "manual");
    if (options.length === 0) return null;
    const numeric = options.every((o) => o.value !== "" && !Number.isNaN(Number(o.value))) && typeof fallback === "number";
    return {
      ...base, kind: "select", options,
      read: (raw) => (raw === null || raw === undefined ? String(fallback ?? options[0].value) : String(raw)),
      write: (next) => (numeric ? Number(next) : String(next)),
    };
  }
  if (row.control === "text") {
    return { ...base, kind: "text", options: [], read: (raw) => (raw === null || raw === undefined ? "" : String(raw)), write: (next) => String(next) };
  }
  void passthrough;
  return null;
}

/** The value to write to reset a control to the web's default. */
export function resetValue(spec: ResolvedControl, raw: unknown): string | boolean | number | null {
  if (spec.reset) return spec.reset(raw);
  return spec.field === "storageCleanup" || spec.field === "sourceControlWritingStyle" ? spec.write(spec.fallback as never, raw) : spec.fallback;
}
