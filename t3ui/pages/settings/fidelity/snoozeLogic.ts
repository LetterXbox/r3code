// SnoozePresetsSettings.tsx / .logic.ts: the pure side of the snooze options editor. Resolution of a preset to a wake
// time reuses the sidebar's resolver (components/sidebar/snooze.ts), which mirrors threadSettled.ts.
import { DEFAULT_SNOOZE_PRESETS, resolveSnoozePresets, type SnoozePresetSetting } from "../../../components/sidebar/snooze";

export { DEFAULT_SNOOZE_PRESETS };
export type { SnoozePresetSetting };
export const MAX_SNOOZE_PRESET_MINUTES = 30 * 24 * 60;
export const MAX_SNOOZE_PRESETS = 8;

export const UNIT_MINUTES = { minutes: 1, hours: 60, days: 24 * 60 } as const;
export type DurationUnit = keyof typeof UNIT_MINUTES;
export const UNIT_LABELS: Record<DurationUnit, string> = { minutes: "minutes", hours: "hours", days: "days" };
export const SINGULAR_UNIT_LABELS: Record<DurationUnit, string> = { minutes: "minute", hours: "hour", days: "day" };
export const SNOOZE_DAYS = ["today", "tomorrow", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export const WHEN_LABELS: Record<string, string> = {
  after: "In", today: "Today", tomorrow: "Tomorrow", monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday", thursday: "Thursday",
  friday: "Friday", saturday: "Saturday", sunday: "Sunday",
};
export const WHEN_VALUES = ["after", ...SNOOZE_DAYS];

export const presetId = (preset: SnoozePresetSetting) => (preset.kind === "after" ? `after:${preset.minutes}` : `at:${preset.day}:${preset.time}`);

/** Offered in order when adding, skipping any already in the list. */
const ADD_CANDIDATES: readonly SnoozePresetSetting[] = [
  ...DEFAULT_SNOOZE_PRESETS,
  { kind: "after", minutes: 30 },
  { kind: "at", day: "saturday", time: "09:00" },
  { kind: "after", minutes: 24 * 60 },
];

export function splitMinutes(minutes: number): { amount: number; unit: DurationUnit } {
  if (minutes % UNIT_MINUTES.days === 0) return { amount: minutes / UNIT_MINUTES.days, unit: "days" };
  if (minutes % UNIT_MINUTES.hours === 0) return { amount: minutes / UNIT_MINUTES.hours, unit: "hours" };
  return { amount: minutes, unit: "minutes" };
}

export function nextCandidate(presets: readonly SnoozePresetSetting[]): SnoozePresetSetting {
  const used = new Set(presets.map(presetId));
  return ADD_CANDIDATES.find((candidate) => !used.has(presetId(candidate))) ?? { kind: "after", minutes: 60 };
}

/** Row order is only display order, so it does not make a list differ from the defaults. */
export function sameSnoozePresets(left: readonly SnoozePresetSetting[], right: readonly SnoozePresetSetting[]): boolean {
  const ids = (presets: readonly SnoozePresetSetting[]) => presets.map(presetId).sort().join("|");
  return ids(left) === ids(right);
}

export interface KindMemory { minutes: number; time: string }

/** Switching between a duration and a set time keeps the other kind's last value. */
export function withWhen(preset: SnoozePresetSetting, when: string, memory: KindMemory): SnoozePresetSetting | null {
  if (when === "after") return preset.kind === "after" ? preset : { kind: "after", minutes: memory.minutes };
  if (!(SNOOZE_DAYS as readonly string[]).includes(when)) return null;
  return { kind: "at", day: when, time: preset.kind === "at" ? preset.time : memory.time };
}

const wakeOf = (preset: SnoozePresetSetting, now: Date) => resolveSnoozePresets(now, [preset])[0]?.snoozedUntil ?? null;

/** Orders rows the way the menu lists them: soonest wake first, options with no wake right now (a passed "Today") last. */
export function sortSnoozeRows(presets: readonly SnoozePresetSetting[], now: Date): SnoozePresetSetting[] {
  return presets
    .map((preset, index) => ({ preset, index, wake: wakeOf(preset, now) }))
    .sort((a, b) => (a.wake === b.wake ? a.index - b.index : a.wake === null ? 1 : b.wake === null ? -1 : a.wake < b.wake ? -1 : 1))
    .map((entry) => entry.preset);
}

export type SnoozePreview = { tone: "menu"; label: string; when: string } | { tone: "muted"; text: string };

/** What each row would put in the menu, or why it would not. */
export function snoozePreviews(presets: readonly SnoozePresetSetting[], now: Date): SnoozePreview[] {
  const seenIds = new Set<string>();
  const seenWakes = new Set<string>();
  return presets.map((preset) => {
    const resolved = resolveSnoozePresets(now, [preset])[0];
    if (!resolved) return { tone: "muted", text: "Passed for today" };
    if (seenIds.has(resolved.id)) return { tone: "muted", text: "Duplicate of an option above" };
    if (seenWakes.has(resolved.snoozedUntil)) return { tone: "muted", text: "Same time as an option above" };
    seenIds.add(resolved.id);
    seenWakes.add(resolved.snoozedUntil);
    return { tone: "menu", label: resolved.label, when: resolved.whenLabel };
  });
}

/** The "Menu now: ..." line. */
export function menuNowLine(presets: readonly SnoozePresetSetting[], now: Date): string {
  const menu = resolveSnoozePresets(now, presets);
  const repeated = new Set(menu.map((preset) => preset.label).filter((label, index, labels) => labels.indexOf(label) !== index));
  const order = menu.map((preset) => (repeated.has(preset.label) ? `${preset.label} ${preset.whenLabel}` : preset.label));
  return order.length === 0 ? "Menus offer only Custom…" : `Menu now: ${order.join(" · ")}`;
}

/** The saved value, read defensively: the server's SnoozePresetSettings or the defaults. */
export function readSnoozePresets(raw: unknown): SnoozePresetSetting[] {
  if (!Array.isArray(raw)) return [...DEFAULT_SNOOZE_PRESETS];
  return raw.flatMap((entry) => {
    const item = entry as Record<string, unknown> | null;
    if (item?.kind === "after" && typeof item.minutes === "number" && item.minutes >= 1) return [{ kind: "after", minutes: Math.min(MAX_SNOOZE_PRESET_MINUTES, Math.round(item.minutes)) } as SnoozePresetSetting];
    if (item?.kind === "at" && typeof item.day === "string" && typeof item.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.time)) return [{ kind: "at", day: item.day, time: item.time } as SnoozePresetSetting];
    return [];
  });
}
