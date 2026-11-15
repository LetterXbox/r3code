import { expect, open, test } from "nsh/test";

test("project settings opens the selected project and returns to the list", async () => {
  const app = await open("./ProjectSettingsFixture.tsx", { width: 1100, height: 1000 });
  await app.press("label:New thread in First project");
  await expect(app.texts()).toContain("New thread: one");
  await app.press("label:Settings for Second project");
  await expect(app.value("label:Project name")).toBe("Second project");
  await expect(app.texts()).toContain("/second");
  await expect(app.enabled("label:Remove project")).toBe(false);
  await expect(app.texts()).toContain("Project editing is not available in this environment.");
  await app.press("label:Back to projects");
  await expect(app.shows("label:Settings for First project")).toBe(true);
  await expect(app.shows("label:Settings for Second project")).toBe(true);
});

test("a selected project follows updates and falls back if removed", async () => {
  const app = await open("./ProjectSettingsFixture.tsx", { width: 1100, height: 1000 });
  await app.press("label:Settings for Second project");
  await app.press("label:Update second fixture project");
  await expect(app.value("label:Project name")).toBe("Updated project");
  await app.press("label:Remove second fixture project");
  await expect(app.shows("label:Project name")).toBe(false);
  await expect(app.shows("label:Settings for First project")).toBe(true);
  await expect(app.shows("label:Settings for Updated project")).toBe(false);
});
