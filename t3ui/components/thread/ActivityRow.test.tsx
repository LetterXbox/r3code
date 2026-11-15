import { expect, open, test } from "nsh/test";

test("tool activity reveals and hides its command and output", async () => {
  const app = await open("./ActivityFixture.tsx", { width: 800, height: 600 });
  await expect(app.texts()).not.toContain("npm test\n\nAll tests passed");
  await app.press("label:Expand Command");
  await expect(app.texts()).toContain("npm test\n\nAll tests passed");
  await app.press("label:Collapse Command");
  await expect(app.texts()).not.toContain("npm test\n\nAll tests passed");
});
