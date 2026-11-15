// The Custom snooze date picker (ui/calendar.tsx over react-day-picker) and its "Snooze for" NumberField.
import { expect, open, test } from "nsh/test";
import { addMonths, dayLabel, monthCaption, monthWeeks, moveCalendarFocus, shortDateLabel, weekdayLabels } from "./snoozeCalendarLogic";
import { parseLocalDate } from "./CustomSnoozeDialog";

test("monthWeeks: whole weeks with the neighbouring months' days marked outside", () => {
  // November 2026 starts on a Sunday and ends on a Monday.
  const weeks = monthWeeks(new Date(2026, 10, 13), 0);
  expect(weeks.length).toBe(5);
  expect(weeks[0]![0]!.date.getDate()).toBe(1);
  expect(weeks[0]![0]!.outside).toBe(false);
  expect(weeks[4]![6]!.date.getMonth()).toBe(11);
  expect(weeks[4]![6]!.outside).toBe(true);
  // A week from Monday: the first row starts on Monday October 26.
  const monday = monthWeeks(new Date(2026, 10, 13), 1);
  expect(monday[0]![0]!.date.getDate()).toBe(26);
  expect(monday[0]![0]!.outside).toBe(true);
  expect(weekdayLabels(1)).toEqual(["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]);
});

test("labels: caption, trigger and day button names", () => {
  expect(monthCaption(new Date(2026, 10, 1))).toBe("November 2026");
  expect(shortDateLabel(new Date(2026, 10, 13))).toBe("Nov 13, 2026");
  expect(dayLabel(new Date(2026, 10, 13))).toBe("Friday, November 13th, 2026");
  expect(dayLabel(new Date(2026, 10, 22), true, true)).toBe("Today, Sunday, November 22nd, 2026, selected");
  expect(addMonths(new Date(2026, 0, 31), 1).getDate()).toBe(28);
  expect(parseLocalDate("2026-11-13")!.getDate()).toBe(13);
  expect(parseLocalDate("2026-02-30")).toBeNull();
});

test("moveCalendarFocus: DayPicker's keys, never before the first enabled day", () => {
  const day = new Date(2026, 10, 18);
  expect(moveCalendarFocus(day, "right", null).getDate()).toBe(19);
  expect(moveCalendarFocus(day, "down", null).getDate()).toBe(25);
  expect(moveCalendarFocus(day, "pagedown", null).getMonth()).toBe(11);
  expect(moveCalendarFocus(day, "shift+down", null).getFullYear()).toBe(2027);
  expect(moveCalendarFocus(day, "home", null, 0).getDate()).toBe(15);
  expect(moveCalendarFocus(day, "end", null, 0).getDate()).toBe(21);
  expect(moveCalendarFocus(day, "up", new Date(2026, 10, 13)).getDate()).toBe(13);
});

test("the Date button opens the month grid; a later day chosen there is the wake date", async () => {
  const app = await open("./CustomSnoozeFixture.tsx");
  await app.press("label:Open");
  await app.waitFor("text:Custom snooze");
  const now = new Date(Date.now() + 3_600_000);
  await app.press(`label:Date ${shortDateLabel(now)}`);
  await app.waitFor("label:Choose snooze date");
  await app.press("label:Go to the Next Month");
  const target = new Date(now.getFullYear(), now.getMonth() + 1, 10);
  await app.waitFor(`text:${monthCaption(target)}`);
  await app.press(`label:${dayLabel(target)}`);
  await app.waitFor(`label:Date ${shortDateLabel(target)}`);
  await app.press("label:Snooze");
  await app.waitFor("text:/result=\\d{4}-/");
});

test("Snooze for steps with its buttons and the arrows", async () => {
  const app = await open("./CustomSnoozeFixture.tsx");
  await app.press("label:Open");
  await app.press("label:Duration");
  await app.press("label:Increase duration");
  await app.type("label:Snooze for", "");
  await app.keyboard.press("up");
  await app.keyboard.press("shift+up");
  await app.press("label:Decrease duration");
  await app.press("label:Snooze");
  // 2 + 1 + 1 + 10 - 1 = 13 hours from now.
  await app.waitFor("text:/hours=13$/");
});

test("the dialog's Close X (ui/dialog.tsx showCloseButton) cancels it", async () => {
  const app = await open("./CustomSnoozeFixture.tsx");
  await app.press("label:Open");
  await app.waitFor("text:Custom snooze");
  await app.press("label:Close");
  await app.waitFor("text:result=cancelled");
});
