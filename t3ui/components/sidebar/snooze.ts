// Snooze presets, ported from packages/client-runtime/src/state/threadSettled.ts
// (resolveSnoozePresets, pickSnoozePreset) with DEFAULT_SNOOZE_PRESETS from
// packages/contracts/src/settings.ts. Mirrors the menu text the web builds.

export type SnoozePresetSetting =
  | { kind: "after"; minutes: number }
  | { kind: "at"; day: string; time: string };

export interface SnoozePreset {
  id: string;
  label: string;
  whenLabel: string;
  snoozedUntil: string;
}

export const DEFAULT_SNOOZE_PRESETS: readonly SnoozePresetSetting[] = [
  { kind: "after", minutes: 60 },
  { kind: "after", minutes: 180 },
  { kind: "at", day: "today", time: "18:00" },
  { kind: "at", day: "tomorrow", time: "09:00" },
  { kind: "at", day: "monday", time: "09:00" },
];

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

function timeOfDay(date: Date): string {
  try {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    const hours = date.getHours();
    return `${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
  }
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

function duration(minutes: number): string {
  if (minutes % 1440 === 0) return plural(minutes / 1440, "day");
  if (minutes % 60 === 0) return plural(minutes / 60, "hour");
  return plural(minutes, "minute");
}

function presetId(setting: SnoozePresetSetting): string {
  return setting.kind === "after" ? `after:${setting.minutes}` : `at:${setting.day}:${setting.time}`;
}

function daysAhead(setting: Extract<SnoozePresetSetting, { kind: "at" }>, now: Date): number {
  if (setting.day === "today") return 0;
  if (setting.day === "tomorrow") return 1;
  return ((WEEKDAY_INDEX[setting.day] ?? 1) - now.getDay() + 7) % 7 || 7;
}

function presetLabel(setting: SnoozePresetSetting, ahead: number): string {
  if (setting.kind === "after") return `In ${duration(setting.minutes)}`;
  if (ahead === 0) {
    const hour = Number(setting.time.slice(0, 2));
    return hour < 12 ? "This morning" : hour < 17 ? "This afternoon" : "This evening";
  }
  if (ahead === 1) return "Tomorrow";
  if (setting.day === "monday") return "Next week";
  const name = setting.day[0].toUpperCase() + setting.day.slice(1);
  return ahead === 7 ? `Next ${name}` : name;
}

function resolvePreset(setting: SnoozePresetSetting, now: Date): SnoozePreset | null {
  let wake: Date;
  let ahead = 0;
  if (setting.kind === "after") {
    wake = new Date(now.getTime() + setting.minutes * 60_000);
  } else {
    ahead = daysAhead(setting, now);
    wake = new Date(now);
    wake.setDate(wake.getDate() + ahead);
    wake.setHours(Number(setting.time.slice(0, 2)), Number(setting.time.slice(3)), 0, 0);
    if (wake.getTime() <= now.getTime()) return null;
  }
  const label = presetLabel(setting, ahead);
  const namesDay = setting.kind === "at" && label !== "Next week";
  const time = timeOfDay(wake);
  return {
    id: presetId(setting),
    label,
    whenLabel: namesDay || wake.toDateString() === now.toDateString()
      ? time
      : `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`,
    snoozedUntil: wake.toISOString(),
  };
}

/** The snooze menu: soonest first, one row per wake minute. */
export function resolveSnoozePresets(now: Date, presets: readonly SnoozePresetSetting[] = DEFAULT_SNOOZE_PRESETS): SnoozePreset[] {
  const minute = (preset: SnoozePreset) => Math.floor(Date.parse(preset.snoozedUntil) / 60_000);
  const seen = new Set<number>();
  return presets
    .flatMap((setting) => resolvePreset(setting, now) ?? [])
    .sort((a, b) => minute(a) - minute(b))
    .filter((preset) => {
      if (seen.has(minute(preset))) return false;
      seen.add(minute(preset));
      return true;
    });
}

/** A chosen preset; a duration restarts from the pick time, a set time keeps the shown wake. */
export function pickSnoozePreset(
  shown: readonly SnoozePreset[],
  id: string,
  now: Date,
  presets: readonly SnoozePresetSetting[] = DEFAULT_SNOOZE_PRESETS,
): SnoozePreset | undefined {
  const original = shown.find((preset) => preset.id === id);
  const ahead = original && Date.parse(original.snoozedUntil) > now.getTime() ? original : undefined;
  const setting = presets.find((candidate) => candidate.kind === "after" && presetId(candidate) === id);
  return (setting && resolvePreset(setting, now)) ?? ahead;
}

/** Reads `snoozePresets` from settings, falling back to the defaults when malformed. */
export function snoozePresetsFromSetting(value: unknown): readonly SnoozePresetSetting[] {
  if (!Array.isArray(value)) return DEFAULT_SNOOZE_PRESETS;
  const valid = value.filter((item): item is SnoozePresetSetting => {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    return (row.kind === "after" && typeof row.minutes === "number") ||
      (row.kind === "at" && typeof row.day === "string" && typeof row.time === "string");
  });
  return valid.length === value.length ? valid : DEFAULT_SNOOZE_PRESETS;
}
