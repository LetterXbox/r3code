import { expect, open, test } from "nsh/test";

test("a run's checkpoint becomes a changed-files card: totals, folded folders, and the files past the prefix", async () => {
  const app = await open("./ChangedFilesFixture.tsx", { width: 900, height: 600 });
  await expect(app.shows("label:row:changed-files")).toBe(true);
  await expect(app.texts()).toContain("3 changed files");
  await expect(app.texts()).toContain("+9");
  await expect(app.texts()).toContain("README.md");
  await expect(app.shows("id:entry-icon:markdown")).toBe(true);
  await expect(app.texts()).toContain("src/lib");
  await expect(app.texts()).not.toContain("a.ts");
  await expect(app.texts()).toContain("1 more file in the full diff");
  await app.press("label:Expand all folders");
  await expect(app.texts()).toContain("a.ts");
  await expect(app.shows("id:entry-icon:typescript")).toBe(true);
  await app.press("label:Collapse all folders");
  await expect(app.texts()).not.toContain("a.ts");
  await app.press("label:Expand src/lib");
  await expect(app.texts()).toContain("a.ts");
});

test("Open diff, a file row and the more-files line open the run's turn diff", async () => {
  const app = await open("./ChangedFilesFixture.tsx", { width: 900, height: 600 });
  await app.press("label:Open diff");
  await expect(app.texts()).toContain("opened run-1:src/lib/a.ts");
  await app.press("label:README.md");
  await expect(app.texts()).toContain("opened run-1:README.md");
  await app.press("text:1 more file in the full diff");
  await expect(app.texts()).toContain("opened run-1:src/lib/a.ts");
});

test("right-clicking a file row opens that file's context menu", async () => {
  const app = await open("./ChangedFilesFixture.tsx", { width: 900, height: 600, platform: "macos" });
  await app.rightClick("label:README.md");
  await expect(app.texts()).toContain("opened menu:README.md");
});

test("a changed directory set resets individual expansion overrides", async () => {
  const app = await open("./ChangedFilesFixture.tsx", { width: 900, height: 600 });
  await app.press("label:Expand src/lib");
  await expect(app.texts()).toContain("a.ts");
  await app.press("label:Add directory");
  await expect(app.texts()).not.toContain("a.ts");
  await expect(app.shows("label:Expand src/lib")).toBe(true);
  await expect(app.shows("label:Expand other")).toBe(true);
});
