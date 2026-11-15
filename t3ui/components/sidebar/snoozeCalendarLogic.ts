// The month grid of the Custom snooze date picker (ui/calendar.tsx over react-day-picker, mode "single",
// showOutsideDays, disabled before today, weekStartsOn from timestampFormat.ts): the weeks of a month with the
// neighbouring months' days at the edges, the keyboard moves of DayPicker's focused day, and the labels.

export type WeekdayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export interface CalendarDay { date: Date; outside: boolean }

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export const startOfDay = (date: Date): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate());
export const sameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const addDays = (date: Date, days: number): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

/** addMonths: the same day in the month `months` away, clamped to that month's last day. */
export function addMonths(date: Date, months: number): Date {
  const first = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(date.getDate(), last));
}

/** The weeks shown for the month of `month`: from the week its first day is in to the week its last day is in. */
export function monthWeeks(month: Date, weekStartsOn: WeekdayIndex = 0): CalendarDay[][] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  let day = addDays(first, -((first.getDay() - weekStartsOn + 7) % 7));
  const end = addDays(last, (weekStartsOn + 6 - last.getDay() + 7) % 7);
  const weeks: CalendarDay[][] = [];
  while (day.getTime() <= end.getTime()) {
    const week: CalendarDay[] = [];
    for (let index = 0; index < 7; index++) {
      week.push({ date: day, outside: day.getMonth() !== month.getMonth() });
      day = addDays(day, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** The weekday headers ("Su".."Sa", DayPicker's short names) from the first day of the week. */
export function weekdayLabels(weekStartsOn: WeekdayIndex = 0): string[] {
  return Array.from({ length: 7 }, (_, index) => WEEKDAYS[(weekStartsOn + index) % 7]!);
}

/** The caption: "November 2026". */
export const monthCaption = (month: Date): string => `${MONTHS[month.getMonth()]} ${month.getFullYear()}`;

/** The trigger's label, as `toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })` in en-US: "Nov 13, 2026". */
export const shortDateLabel = (date: Date): string => `${MONTHS[date.getMonth()]!.slice(0, 3)} ${date.getDate()}, ${date.getFullYear()}`;

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ordinal = (day: number): string => {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th"}`;
};

/** A day button's name, DayPicker's labelDayButton (date-fns "PPPP"): "Friday, November 13th, 2026", "Today, " first on today, ", selected" when chosen. */
export const dayLabel = (date: Date, selected = false, today = false): string =>
  `${today ? "Today, " : ""}${WEEKDAY_NAMES[date.getDay()]}, ${MONTHS[date.getMonth()]} ${ordinal(date.getDate())}, ${date.getFullYear()}${selected ? ", selected" : ""}`;

export type CalendarKey = "left" | "right" | "up" | "down" | "shift+left" | "shift+right" | "shift+up" | "shift+down" | "pageup" | "pagedown" | "shift+pageup" | "shift+pagedown" | "home" | "end";

/**
 * DayPicker's focus moves (DayPicker.js onDayKeyDown): arrows a day / a week (with Shift a month / a year), PageUp/PageDown
 * a month, Shift+PageUp/PageDown a year, Home/End
 * the start / end of the week. A move never lands before `minimum` (the disabled days before today).
 */
export function moveCalendarFocus(focused: Date, key: CalendarKey, minimum: Date | null, weekStartsOn: WeekdayIndex = 0): Date {
  let next: Date;
  switch (key) {
    case "left": next = addDays(focused, -1); break;
    case "right": next = addDays(focused, 1); break;
    case "up": next = addDays(focused, -7); break;
    case "down": next = addDays(focused, 7); break;
    case "shift+left": next = addMonths(focused, -1); break;
    case "shift+right": next = addMonths(focused, 1); break;
    case "shift+up": next = addMonths(focused, -12); break;
    case "shift+down": next = addMonths(focused, 12); break;
    case "pageup": next = addMonths(focused, -1); break;
    case "pagedown": next = addMonths(focused, 1); break;
    case "shift+pageup": next = addMonths(focused, -12); break;
    case "shift+pagedown": next = addMonths(focused, 12); break;
    case "home": next = addDays(focused, -((focused.getDay() - weekStartsOn + 7) % 7)); break;
    case "end": next = addDays(focused, (weekStartsOn + 6 - focused.getDay() + 7) % 7); break;
  }
  return minimum && next.getTime() < startOfDay(minimum).getTime() ? startOfDay(minimum) : next;
}

/** timestampFormat.ts resolveWeekStartsOn: the locale's first weekday, or undefined when the runtime has no week data. */
export function resolveWeekStartsOn(): WeekdayIndex | undefined {
  try {
    const IntlLocale = (globalThis as { Intl?: { Locale?: new (tag: string) => { getWeekInfo?: () => { firstDay?: number }; weekInfo?: { firstDay?: number } } ; DateTimeFormat?: () => { resolvedOptions(): { locale: string } } } }).Intl;
    if (!IntlLocale?.Locale || !IntlLocale.DateTimeFormat) return undefined;
    const locale = new IntlLocale.Locale(IntlLocale.DateTimeFormat().resolvedOptions().locale);
    const firstDay = locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay;
    return firstDay === undefined ? undefined : ((firstDay % 7) as WeekdayIndex);
  } catch {
    return undefined;
  }
}
