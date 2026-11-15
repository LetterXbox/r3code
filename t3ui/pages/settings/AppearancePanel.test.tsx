import { expect, open, test } from "nsh/test";

test("the Interface rows show value chips, and the closed Chat width select reads 'Comfortable'", async () => {
  const app = await open("./AppearancePanelFixture.tsx", { width: 1000, height: 1800 });
  for (const text of ["Contrast", "Glass opacity", "Chat width", "100%", "80%"]) await expect(app.texts()).toContain(text);
  await expect(app.texts()).toContain("Comfortable");
  await expect(app.texts()).not.toContain("Comfortable (default)");
  await expect(app.shows("id:Contrast = 100")).toBe(true);
  await expect(app.shows("id:Glass opacity = 80")).toBe(true);
});

test("Environment identification (under Advanced) offers the Dev stage's options and describes them", async () => {
  const app = await open("./AppearancePanelFixture.tsx", { width: 1000, height: 2200 });
  await app.press("label:Advanced");
  await expect(app.texts()).toContain("Environment identification");
  await expect(app.texts()).toContain("Choose how Dev and Nightly environments are identified.");
  // The default `artwork` is labelled as the stage's art: this build's stage is Dev.
  await expect(app.texts()).toContain("Dev artwork");
  await app.press("label:Environment identification = artwork");
  for (const label of ["Nightly artwork", "Version pill", "None"]) await expect(app.texts()).toContain(label);
});
