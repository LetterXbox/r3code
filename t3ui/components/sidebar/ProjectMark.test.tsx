import { expect, open, test } from "nsh/test";

const options = { width: 320, height: 300, platform: "macos" as const };

test("the derived monogram shows when a project has nothing configured", async () => {
  const app = await open("./ProjectMarkFixture.tsx", options);
  await expect(app.texts()).toContain("DN");
});

test("a configured monogram shows its own text", async () => {
  const app = await open("./ProjectMarkFixture.tsx", options);
  await expect(app.texts()).toContain("QZ");
});

test("a configured emoji shows, and an unknown lucide mark does not leave text behind", async () => {
  const app = await open("./ProjectMarkFixture.tsx", options);
  await expect(app.texts()).toContain("R");
  await expect(app.texts()).not.toContain("LU");
});

test("a favicon address draws an image in place of the monogram", async () => {
  const app = await open("./ProjectMarkFixture.tsx", options);
  await expect(app.texts()).not.toContain("FA");
  await expect(app.count("label:Favicon icon")).toBe(1);
});
