import { expect, open, test } from "nsh/test";

test("a side chat's divider reads Context from <title> and opens the parent thread", async () => {
  const app = await open("./ThreadContextDividerFixture.tsx", { width: 800, height: 300 });
  await expect(app.texts()).toContain("Context from");
  await expect(app.texts().some((text) => text.includes("Planner"))).toBe(true);
  await app.press("label:Open parent thread");
  await expect(app.texts()).toContain("opened:1");
});
