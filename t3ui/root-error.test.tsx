// A render error shows the root error view; Try again renders the app again and Copy error copies the report.
import { expect, open, test } from "nsh/test";

test("a render error shows Something went wrong with the message, and Try again brings the app back", async () => {
  const app = await open("./ErrorFixture.tsx", { width: 1000, height: 700, platform: "macos" });
  await expect(app.texts()).toContain("All good");
  await app.press("label:Break");
  await app.waitFor("text:Something went wrong.");
  await expect(app.texts()).toContain("Render failed");
  await expect(app.texts()).toContain("Error report");
  await app.press("label:Mend");
  await app.press("label:Try again");
  await app.waitFor("text:All good");
});

test("Copy error puts the report on the clipboard", async () => {
  const app = await open("./ErrorFixture.tsx", { width: 1000, height: 700, platform: "macos" });
  await app.press("label:Break");
  await app.waitFor("label:Copy error");
  await app.press("label:Copy error");
  await app.waitFor("label:Copied");
  const copied = app.clipboard() ?? "";
  await expect(copied.startsWith("R3 Code ")).toBe(true);
  await expect(copied).toContain("Render failed");
});
