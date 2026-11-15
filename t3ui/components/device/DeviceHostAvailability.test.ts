import { expect, test } from "nsh/test";
import { availabilityLabel, availabilityTip } from "./DeviceHostAvailability";

test("labels name the platform and whether it is available", () => {
  expect(availabilityLabel({ platform: "ios", available: true })).toBe("iOS available");
  expect(availabilityLabel({ platform: "android", available: false })).toBe("Android unavailable");
});

test("the tooltip is the host's reason, else the plain available text", () => {
  expect(availabilityTip({ platform: "android", available: false, reason: "adb not found" })).toBe("adb not found");
  expect(availabilityTip({ platform: "ios", available: true })).toBe("iOS available");
  expect(availabilityTip({ platform: "android", available: true })).toBe("Android available");
});
