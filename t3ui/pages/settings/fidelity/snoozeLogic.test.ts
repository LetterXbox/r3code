import { expect, test } from "nsh/test";
import { DEFAULT_SNOOZE_PRESETS, menuNowLine, nextCandidate, readSnoozePresets, sameSnoozePresets, snoozePreviews, sortSnoozeRows, splitMinutes, withWhen } from "./snoozeLogic";

// Wednesday 2025-01-15 10:00 local time.
const now = new Date(2025, 0, 15, 10, 0, 0);

test("the defaults list the menu soonest first, and a passed Today is last in the editor", () => {
  expect(menuNowLine(DEFAULT_SNOOZE_PRESETS, now).startsWith("Menu now: In 1 hour · In 3 hours · This evening")).toBe(true);
  const late = new Date(2025, 0, 15, 19, 0, 0);
  const sorted = sortSnoozeRows(DEFAULT_SNOOZE_PRESETS, late);
  expect(sorted[sorted.length - 1]).toEqual({ kind: "at", day: "today", time: "18:00" });
  expect(snoozePreviews([{ kind: "at", day: "today", time: "18:00" }], late)).toEqual([{ tone: "muted", text: "Passed for today" }]);
});

test("duplicates and same-minute options explain why they are not in the menu", () => {
  const previews = snoozePreviews([{ kind: "after", minutes: 60 }, { kind: "after", minutes: 60 }, { kind: "at", day: "today", time: "11:00" }], now);
  expect(previews[0]?.tone).toBe("menu");
  expect(previews[1]).toEqual({ tone: "muted", text: "Duplicate of an option above" });
  expect(previews[2]).toEqual({ tone: "muted", text: "Same time as an option above" });
  expect(menuNowLine([], now)).toBe("Menus offer only Custom…");
});

test("durations split into the largest whole unit and switching kind remembers the other value", () => {
  expect(splitMinutes(180)).toEqual({ amount: 3, unit: "hours" });
  expect(splitMinutes(2880)).toEqual({ amount: 2, unit: "days" });
  expect(splitMinutes(45)).toEqual({ amount: 45, unit: "minutes" });
  const memory = { minutes: 90, time: "08:30" };
  expect(withWhen({ kind: "after", minutes: 60 }, "friday", memory)).toEqual({ kind: "at", day: "friday", time: "08:30" });
  expect(withWhen({ kind: "at", day: "friday", time: "07:15" }, "after", memory)).toEqual({ kind: "after", minutes: 90 });
  expect(withWhen({ kind: "at", day: "friday", time: "07:15" }, "tomorrow", memory)).toEqual({ kind: "at", day: "tomorrow", time: "07:15" });
  expect(withWhen({ kind: "after", minutes: 60 }, "someday", memory)).toBe(null);
});

test("add offers the next unused default; row order does not make a list differ from the defaults", () => {
  expect(nextCandidate(DEFAULT_SNOOZE_PRESETS)).toEqual({ kind: "after", minutes: 30 });
  expect(sameSnoozePresets([...DEFAULT_SNOOZE_PRESETS].reverse(), DEFAULT_SNOOZE_PRESETS)).toBe(true);
  expect(sameSnoozePresets([{ kind: "after", minutes: 60 }], DEFAULT_SNOOZE_PRESETS)).toBe(false);
});

test("the saved value reads from the server's shape and falls back to the defaults", () => {
  expect(readSnoozePresets(undefined)).toEqual([...DEFAULT_SNOOZE_PRESETS]);
  expect(readSnoozePresets([{ kind: "after", minutes: 30 }, { kind: "at", day: "friday", time: "9:00" }, { kind: "nope" }])).toEqual([{ kind: "after", minutes: 30 }]);
});
