import { expect, open, test } from "nsh/test";

const options = { width: 240, height: 160, platform: "macos" as const };

test("the drag label holds hidden for the first 200ms of a pickup, then shows at once", async () => {
  const app = await open("./StepRevealFixture.tsx", options);
  expect(app.texts()).toContain("hidden");
  await app.press("text:Toggle");
  expect(app.texts()).toContain("hidden");
  await app.waitUntil(() => app.texts().includes("shown"));
  await app.press("text:Toggle");
  await app.waitUntil(() => app.texts().includes("hidden"));
});
