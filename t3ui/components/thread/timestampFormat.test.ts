import { expect, test } from "nsh/test";
import { asTimestampFormat, formatChatTimestampTooltip, formatDayAwareTimestamp } from "./timestampFormat";

const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min).getTime();

test("today shows the time only, yesterday names the day, older shows the date", () => {
  const now = at(2026, 6, 15, 14, 0);
  expect(formatDayAwareTimestamp(at(2026, 6, 15, 9, 5), "24-hour", now)).toBe("09:05");
  expect(formatDayAwareTimestamp(at(2026, 6, 14, 23, 30), "24-hour", now)).toBe("yesterday at 23:30");
  expect(formatDayAwareTimestamp(at(2026, 6, 10, 9, 5), "24-hour", now)).toContain("09:05");
  expect(formatDayAwareTimestamp(at(2026, 6, 10, 9, 5), "24-hour", now)).not.toContain("2026");
  expect(formatDayAwareTimestamp(at(2025, 6, 10, 9, 5), "24-hour", now)).toContain("2025");
});

test("12-hour format carries a day period", () => {
  expect(formatDayAwareTimestamp(at(2026, 6, 15, 15, 5), "12-hour", at(2026, 6, 15, 16, 0))).toMatch(/3:05\s?PM/i);
});

test("the tooltip spells out the date with an ordinal day", () => {
  expect(formatChatTimestampTooltip(at(2026, 6, 1, 9, 5), "24-hour")).toBe("09:05, 1st June 2026");
  expect(formatChatTimestampTooltip(at(2026, 6, 12, 9, 5), "24-hour")).toBe("09:05, 12th June 2026");
  expect(formatChatTimestampTooltip(at(2026, 6, 23, 9, 5), "24-hour")).toBe("09:05, 23rd June 2026");
});

test("missing times format as nothing and unknown settings fall back to locale", () => {
  expect(formatDayAwareTimestamp(0, "locale")).toBe("");
  expect(asTimestampFormat("nope")).toBe("locale");
  expect(asTimestampFormat("24-hour")).toBe("24-hour");
});
