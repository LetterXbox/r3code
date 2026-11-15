import { expect, test } from "nsh/test";
import { DEFAULT_USAGE_PAGE_PREFERENCES, parseUsagePagePreferences, serializeUsagePagePreferences } from "./usagePagePreferences";

test("usage page preferences round-trip and default to limits / 30 days", () => {
  expect(parseUsagePagePreferences(null)).toEqual(DEFAULT_USAGE_PAGE_PREFERENCES);
  expect(parseUsagePagePreferences("{bad")).toEqual({ metric: "limits", windowDays: 30 });
  expect(parseUsagePagePreferences(JSON.stringify({ metric: "cost", windowDays: 14 }))).toEqual({ metric: "limits", windowDays: 30 });
  expect(parseUsagePagePreferences(serializeUsagePagePreferences({ metric: "tokens", windowDays: 7 }))).toEqual({ metric: "tokens", windowDays: 7 });
});
