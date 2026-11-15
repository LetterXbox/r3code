import { expect, open, test } from "nsh/test";

test("the banner names the provider, shows N% left per window and when it resets, and dismisses", async () => {
  const app = await open("./UsageLimitsFixture.tsx", { width: 700, height: 500, platform: "macos" });
  await expect(app.texts()).toContain("Usage limits");
  await expect(app.texts()).toContain("Claude · Max");
  await expect(app.shows("label:5h session: 70% left")).toBe(true);
  await expect(app.shows("label:Weekly: 0% left")).toBe(true);
  await expect(app.texts().some((text) => text.includes("resets in 2h 30m"))).toBe(true);
  await expect(app.texts()).toContain("2 reset credits available");
  await app.press("label:Dismiss usage limits");
  await expect(app.shows("label:Dismiss usage limits")).toBe(false);
});
