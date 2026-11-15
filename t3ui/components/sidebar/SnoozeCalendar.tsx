// CustomSnoozeDialog.tsx's Date field: an outline button with the chosen day ("Nov 13, 2026") and a CalendarIcon that
// opens a PopoverPopup ("Choose snooze date") with ui/calendar.tsx's month grid: caption, previous / next month
// buttons, weekday headers, outside days muted, days before today disabled and struck through, today marked with a
// dot, the chosen day filled with primary. Pressing a day chooses it and closes the popup. While it is open the
// keyboard moves DayPicker's focused day (snoozeCalendarLogic.ts), Enter / Space chooses it and Escape closes.
import { cleanup, effect, Image, keymap, signal, Text, token, untracked, View } from "nsh";
import calendarMark from "../../icons/calendar.svg";
import chevronLeft from "../../icons/chevron-left.svg";
import chevronRight from "../../icons/chevron-right.svg";
import {
  dayLabel, monthCaption, monthWeeks, moveCalendarFocus, resolveWeekStartsOn, sameDay, shortDateLabel, startOfDay, weekdayLabels,
  type CalendarKey, type WeekdayIndex,
} from "./snoozeCalendarLogic";

const KEYS: CalendarKey[] = ["left", "right", "up", "down", "shift+left", "shift+right", "shift+up", "shift+down", "pageup", "pagedown", "shift+pageup", "shift+pagedown", "home", "end"];
const weekStart: WeekdayIndex = resolveWeekStartsOn() ?? 0;

const mark = (src: typeof calendarMark, size: number, tint: string) => <Image src={src} fadeDuration={0} style={{ width: size, height: size, tintColor: tint }} />;

export function SnoozeDateField(props: { value: Date; today: Date; onChange: (date: Date) => void }) {
  const open = signal(false);
  const month = signal(untracked(() => props.value));
  const focused = signal(untracked(() => props.value));
  effect(() => {
    if (!open()) return;
    // defaultMonth={date}: each opening starts at the chosen day.
    untracked(() => { month.set(props.value); focused.set(props.value); });
    const bindings: Record<string, () => void> = {};
    for (const key of KEYS) {
      bindings[key] = () => {
        const next = moveCalendarFocus(focused(), key, props.today, weekStart);
        focused.set(next);
        if (next.getMonth() !== month().getMonth() || next.getFullYear() !== month().getFullYear()) month.set(next);
      };
    }
    bindings.enter = () => choose(focused());
    bindings.space = () => choose(focused());
    bindings.escape = () => open.set(false);
    const release = keymap.bind(bindings, { when: "always", repeat: true });
    return release;
  });
  cleanup(() => open.set(false));
  function choose(date: Date) {
    if (date.getTime() < startOfDay(props.today).getTime()) return;
    props.onChange(date);
    open.set(false);
  }
  const shiftMonth = (by: number) => month.set(new Date(month().getFullYear(), month().getMonth() + by, 1));
  const navButton = (label: string, src: typeof chevronLeft, by: number) => (
    <View role="button" accessibilityLabel={label} onPress={() => shiftMonth(by)} class="size-9 items-center justify-center rounded-lg hover:bg-accent">
      {mark(src, 16, String(token("foreground")))}
    </View>
  );
  return (
    <View class="relative min-w-0 flex-1 gap-2 z-10">
      <Text class="text-sm font-medium text-foreground">Date</Text>
      <View
        role="button"
        accessibilityLabel={`Date ${shortDateLabel(props.value)}`}
        accessibilityState={{ expanded: open() }}
        onPress={() => open.set(!open())}
        class="h-8 flex-row items-center justify-between rounded-lg border border-input bg-background px-3 hover:bg-accent-50"
      >
        <Text class="text-sm font-medium text-foreground">{shortDateLabel(props.value)}</Text>
        {mark(calendarMark, 16, String(token("muted-foreground")))}
      </View>
      {open() ? (
        <View accessibilityLabel="Choose snooze date" class="absolute left-0 top-16 z-50 rounded-lg border border-border bg-popover p-3 shadow-lg">
          <View class="relative mb-1 h-9 flex-row items-center justify-center">
            <View class="absolute left-0 top-0">{navButton("Go to the Previous Month", chevronLeft, -1)}</View>
            <Text class="text-sm font-medium text-foreground">{monthCaption(month())}</Text>
            <View class="absolute right-0 top-0">{navButton("Go to the Next Month", chevronRight, 1)}</View>
          </View>
          <View role="grid" accessibilityLabel={monthCaption(month())}>
            <View class="flex-row">
              {weekdayLabels(weekStart).map((name) => <View class="size-9 items-center justify-center"><Text class="text-xs font-medium text-muted-foreground-70">{name}</Text></View>)}
            </View>
            {monthWeeks(month(), weekStart).map((week) => (
              <View class="flex-row">
                {week.map((day) => {
                  const selected = sameDay(day.date, props.value);
                  const disabled = day.date.getTime() < startOfDay(props.today).getTime();
                  const isToday = sameDay(day.date, props.today);
                  const isFocused = sameDay(day.date, focused());
                  const text = selected ? "text-primary-foreground" : disabled || day.outside ? "text-muted-foreground-70" : "text-foreground";
                  return (
                    <View class="size-9 py-px">
                      <View
                        role="button"
                        accessibilityLabel={dayLabel(day.date, selected, isToday)}
                        accessibilityState={{ selected, disabled }}
                        disabled={disabled}
                        onPress={() => choose(day.date)}
                        class={`relative flex-1 items-center justify-center rounded-lg ${selected ? "bg-primary" : disabled ? "" : "hover:bg-accent"} ${disabled ? "opacity-64" : ""} ${isFocused && !selected ? "border border-ring" : ""}`}
                      >
                        <Text class={`text-sm ${text} ${disabled ? "line-through" : ""}`}>{String(day.date.getDate())}</Text>
                        {isToday ? <View class={`absolute bottom-1 size-[3px] rounded-full ${selected ? "bg-background" : "bg-primary"}`} /> : null}
                      </View>
                    </View>
                  );
                })}
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}
