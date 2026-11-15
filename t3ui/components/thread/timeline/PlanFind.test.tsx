import { expect, open, test } from "nsh/test";

test("a find match in a collapsed plan's hidden lines expands the plan (ProposedPlanCard findRevealRef)", async () => {
  const app = await open("./PlanFindFixture.tsx", { width: 900, height: 1400 });
  await app.waitFor("label:Expand plan");
  expect((await app.texts()).some((text) => text.includes("hiddenneedle"))).toBe(false);
  await app.press("label:Find hidden");
  await app.waitUntil(() => app.texts().some((text) => text.includes("hiddenneedle")));
  await expect(app.shows("label:Collapse plan")).toBe(true);
});
