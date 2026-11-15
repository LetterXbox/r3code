import { expect, test } from "nsh/test";
import { msUntilRelativeTimeChange } from "./clock";

test("fm13: a relative label's next change: the next minute, hour or day boundary of its own timestamp", () => {
  const t = 1_700_000_000_000;
  expect(msUntilRelativeTimeChange(t, t + 10_000)).toBe(50_000);
  expect(msUntilRelativeTimeChange(t, t + 5 * 60_000 + 1_000)).toBe(59_000);
  expect(msUntilRelativeTimeChange(t, t + 2 * 3_600_000 + 60_000)).toBe(3_540_000);
  expect(msUntilRelativeTimeChange(t, t + 3 * 86_400_000)).toBe(86_400_000);
});
