import { expect, test } from "nsh/test";
import { dismissThreadErrorBannerForSession, getThreadErrorBannerKey, getThreadErrorBannerMessage, shouldShowThreadErrorBanner } from "./threadError";

test("a JSON error payload shows its nested message, anything else shows as is", () => {
  expect(getThreadErrorBannerMessage('{"error":{"message":"Rate limited"}}')).toBe("Rate limited");
  expect(getThreadErrorBannerMessage('{"error":{"message":"  "}}')).toBe('{"error":{"message":"  "}}');
  expect(getThreadErrorBannerMessage("plain failure")).toBe("plain failure");
  expect(getThreadErrorBannerMessage('{"other":1}')).toBe('{"other":1}');
});

test("a dismissed error stays hidden for its thread only", () => {
  expect(getThreadErrorBannerKey("t1", null)).toBeNull();
  expect(shouldShowThreadErrorBanner("t1", "boom")).toBe(true);
  dismissThreadErrorBannerForSession(getThreadErrorBannerKey("t1", "boom"));
  expect(shouldShowThreadErrorBanner("t1", "boom")).toBe(false);
  expect(shouldShowThreadErrorBanner("t2", "boom")).toBe(true);
  expect(shouldShowThreadErrorBanner("t1", "other")).toBe(true);
  expect(shouldShowThreadErrorBanner("t1", null)).toBe(false);
});
