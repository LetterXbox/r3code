// formatDayAwareTimestamp and formatChatTimestampTooltip from apps/web/src/timestampFormat.ts,
// taking epoch milliseconds (the native store keeps message times as numbers).
export type TimestampFormat = "locale" | "12-hour" | "24-hour";

export function asTimestampFormat(value: unknown): TimestampFormat {
  return value === "12-hour" || value === "24-hour" ? value : "locale";
}

function timeFormatter(format: TimestampFormat): Intl.DateTimeFormat {
  const base: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  return new Intl.DateTimeFormat(undefined, format === "locale" ? base : { ...base, hour12: format === "12-hour" });
}

const monthName = new Intl.DateTimeFormat("en-US", { month: "long" });

function ordinalSuffix(day: number): string {
  const lastTwo = day % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return "th";
  switch (day % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

const dayIndex = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;

export function formatShortTimestamp(ms: number, format: TimestampFormat): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return timeFormatter(format).format(new Date(ms));
}

/** Today shows the time; yesterday "yesterday at <time>"; earlier "<m/d> <time>", with the year when it differs. */
export function formatDayAwareTimestamp(ms: number, format: TimestampFormat, nowMs: number = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const date = new Date(ms);
  const time = timeFormatter(format).format(date);
  const now = new Date(nowMs);
  const diff = dayIndex(now) - dayIndex(date);
  if (diff <= 0) return time;
  if (diff === 1) return `yesterday at ${time}`;
  const options: Intl.DateTimeFormatOptions = date.getFullYear() === now.getFullYear()
    ? { month: "numeric", day: "numeric" }
    : { month: "numeric", day: "numeric", year: "numeric" };
  return `${new Intl.DateTimeFormat(undefined, options).format(date)} ${time}`;
}

export function formatChatTimestampTooltip(ms: number, format: TimestampFormat): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const date = new Date(ms);
  const day = date.getDate();
  return `${formatShortTimestamp(ms, format)}, ${day}${ordinalSuffix(day)} ${monthName.format(date)} ${date.getFullYear()}`;
}
