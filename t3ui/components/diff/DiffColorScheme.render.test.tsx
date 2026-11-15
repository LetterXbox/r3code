import { expect, open, test } from "nsh/test";

// A render-level check (not just the helper's strings) that flipping "Diff colors" live
// recolors a real DiffView-backed surface: the changed-files header stat in DiffPanel.tsx,
// driven through DiffHarness.tsx's "Blue & orange" button, which calls updateSetting the same
// way the real settings row does. No restart or reload happens between the two readings.
test("flipping diffColorScheme recolors DiffPanel's +/- stats from emerald/red to blue/orange, live", async () => {
  const app = await open("./DiffHarness.tsx", { width: 1000, height: 800 });
  await app.waitFor("label:File src/second.ts");

  // Default (red-green): Tailwind emerald-700 / red-700.
  expect((await app.spanStyle("text:+2")).color).toBe("#007a55ff");
  expect((await app.spanStyle("text:-1 >> nth=0")).color).toBe("#c10007ff");

  await app.press("label:Diff colors: blue-orange");

  // Blue-orange: Tailwind blue-600 / orange-600, matching the reference's
  // index.css L2300-2301 (`--diff-addition`/`--diff-deletion` under
  // `:root[data-diff-color-scheme="blue-orange"]`).
  expect((await app.spanStyle("text:+2")).color).toBe("#155dfcff");
  expect((await app.spanStyle("text:-1 >> nth=0")).color).toBe("#f54900ff");
});
