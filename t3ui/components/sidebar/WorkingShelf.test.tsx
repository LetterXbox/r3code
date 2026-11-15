import { expect, open, test } from "nsh/test";

const options = { width: 320, height: 420, platform: "macos" as const };

test("the Working shelf lists both threads under a counted header, with Settled closed below", async () => {
  const app = await open("./WorkingShelfFixture.tsx", options);
  await expect(app.shows("label:Working threads, 2")).toBe(true);
  await expect(app.shows("label:Settled threads, 2")).toBe(true);
  await expect(app.shows("label:Match T3 Code Functionality And Design, Working, t3codegpui")).toBe(true);
  await expect(app.shows("label:Agent Harness Reliability Review, Waiting, jasonkneen/legion")).toBe(true);
  // Settled is closed: its rows are not drawn.
  await expect(app.texts()).not.toContain("Old finished thread");
});

test("each card has the project line, the status with its duration, the title and the branch", async () => {
  const app = await open("./WorkingShelfFixture.tsx", options);
  const texts = app.texts();
  await expect(texts).toContain("t3codegpui");
  await expect(texts).toContain("jasonkneen/legion");
  await expect(texts).toContain("Working");
  await expect(texts).toContain("6m");
  await expect(texts).toContain("Waiting");
  await expect(texts).toContain("24m");
  await expect(texts).toContain("Match T3 Code Functionality And Design");
  await expect(texts).toContain("legion-merge");
});
