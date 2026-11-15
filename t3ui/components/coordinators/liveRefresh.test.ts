import { expect, test } from "nsh/test";
import { LIVE_REFRESH_IDLE_AFTER_MS, shouldRefreshOnArrival, shouldRefreshOnInterval, workspaceMutationRefreshToken } from "./liveRefresh";

test("arrival refreshes only a view read before and at least 10 s ago", () => {
  expect(shouldRefreshOnArrival({ visible: true, now: 20_000, lastRefreshedAt: undefined })).toBe(false);
  expect(shouldRefreshOnArrival({ visible: true, now: 20_000, lastRefreshedAt: 15_000 })).toBe(false);
  expect(shouldRefreshOnArrival({ visible: true, now: 20_000, lastRefreshedAt: 10_000 })).toBe(true);
  expect(shouldRefreshOnArrival({ visible: false, now: 20_000, lastRefreshedAt: 0 })).toBe(false);
});

test("the interval pauses after 6 minutes without interaction", () => {
  expect(shouldRefreshOnInterval({ visible: true, now: 400_000, lastRefreshedAt: 0, lastInteractedAt: 399_000 })).toBe(true);
  expect(shouldRefreshOnInterval({ visible: true, now: LIVE_REFRESH_IDLE_AFTER_MS + 1, lastRefreshedAt: 0, lastInteractedAt: 0 })).toBe(false);
});

test("a mutation token pairs the resource with the mutation id", () => {
  expect(workspaceMutationRefreshToken("files:a", null)).toBe(null);
  expect(workspaceMutationRefreshToken("files:a", "m1")).toBe("files:a\u0000m1");
});
