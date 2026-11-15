import { expect, open, test } from "nsh/test";

test("at a wide window the settings nav shows labels and headings", async () => {
  const app = await open("./App.tsx", { width: 1280, height: 800 });
  await app.keyboard.press("mod+,");
  for (const text of ["General", "Appearance", "Providers", "Agents", "Code", "Connections"]) await expect(app.texts()).toContain(text);
});

test("below the md breakpoint the nav is an icon rail with a search button", async () => {
  const app = await open("./App.tsx", { width: 700, height: 800 });
  await app.keyboard.press("mod+,");
  await expect(app.shows("label:Search settings")).toBe(true);
  await expect(app.shows("label:Appearance")).toBe(true);
  // headings and labels are gone from the rail; the breadcrumb still names the section
  await expect(app.texts()).not.toContain("Agents");
  await app.press("label:Search settings");
  await expect(app.texts()).toContain("Agents");
});
