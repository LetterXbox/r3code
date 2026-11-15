import { expect, open, test } from "nsh/test";
import { relativeTimeLabel, settledLabel, snoozedLabel } from "./ThreadStatusLine";

test("relative labels follow formatRelativeTimeLabel", () => {
  expect(relativeTimeLabel(0)).toBe("just now");
  expect(relativeTimeLabel(59_000)).toBe("just now");
  expect(relativeTimeLabel(5 * 60_000)).toBe("5m ago");
  expect(relativeTimeLabel(3 * 3_600_000)).toBe("3h ago");
  expect(relativeTimeLabel(2 * 86_400_000)).toBe("2d ago");
  expect(settledLabel(null, 1000)).toBe("Settled");
  expect(settledLabel(1000, 1000)).toBe("Settled just now");
});

test("a settled thread shows Settled <ago> and Un-settle sends the unsettle for that thread; an active one shows nothing", async () => {
  const app = await open("./ThreadStatusLineFixture.tsx", { width: 700, height: 200 });
  await expect(app.texts()).toContain("Settled 5m ago");
  await expect(app.texts()).toContain("Un-settle");
  await app.press("label:Un-settle");
  await expect(app.texts()).toContain("unsettle settled");
  await app.press("label:Open active");
  await expect(app.texts()).not.toContain("Un-settle");
});

test("Un-settle underlines on hover (createHover(), since group-hover: does not reach a descendant)", async () => {
  const app = await open("./ThreadStatusLineFixture.tsx", { width: 700, height: 200, platform: "macos" });
  const before = (await app.spanStyle("text:Un-settle")).underline;
  await app.hover("label:Un-settle");
  const after = (await app.spanStyle("text:Un-settle")).underline;
  await expect(before).toBe(false);
  await expect(after).toBe(true);
});

test("snoozed label reads the wake label, plain Snoozed once it is due", () => {
  expect(snoozedLabel(3 * 3_600_000, 0)).toBe("Snoozed, 3h left");
  expect(snoozedLabel(1000, 5000)).toBe("Snoozed");
  expect(snoozedLabel(null, 0)).toBe("Snoozed");
});

test("a snoozed thread shows Snoozed, N left with Wake now; a woke unseen one shows Woke from snooze with Dismiss", async () => {
  const app = await open("./ThreadStatusLineFixture.tsx", { width: 700, height: 240 });
  await app.press("label:Open snoozed");
  await expect(app.texts()).toContain("Snoozed, 3h left");
  await app.press("label:Wake now");
  await expect(app.texts()).toContain("unsnooze snoozed");
  await app.press("label:Open woke");
  await expect(app.texts()).toContain("Woke from snooze");
  await app.press("label:Dismiss");
  await expect(app.texts()).toContain("visit woke");
});
