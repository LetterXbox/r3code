import { expect, open, test } from "nsh/test";
import { shouldAnimateSnapShotArrival, snapShotArrival } from "../../desktop/snapShotArrival";

test("a capture under ten seconds old arrives with the animation, an older or future one does not", () => {
  const now = Date.parse("2026-01-01T00:00:10.000Z");
  expect(shouldAnimateSnapShotArrival("2026-01-01T00:00:00.000Z", now)).toBe(true);
  expect(shouldAnimateSnapShotArrival("2025-12-31T23:59:59.000Z", now)).toBe(false);
  expect(shouldAnimateSnapShotArrival("2026-01-01T00:00:11.000Z", now)).toBe(false);
  expect(shouldAnimateSnapShotArrival("not a date", now)).toBe(false);
  expect(snapShotArrival.duration).toBe(300);
});

test("a captured file gets the wide SnapShot tile with its close button, a picked image keeps the small one", async () => {
  const app = await open("./SnapShotAttachmentFixture.tsx", { width: 600, height: 400, platform: "macos" });
  expect(app.count("id:SnapShot attachment")).toBe(1);
  await app.hover("id:SnapShot attachment");
  await app.press("label:Remove window-2026-01-01T00-00-00.000Z.png");
  await app.waitUntil(() => app.count("id:SnapShot attachment") === 0);
  expect(app.shows("label:Remove photo.png")).toBe(true);
});
