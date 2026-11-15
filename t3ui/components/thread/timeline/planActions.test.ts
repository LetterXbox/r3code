import { expect, test } from "nsh/test";
import { buildProposedPlanMarkdownFilename, canCollapsePlan, collapsedPlanPreview, normalizePlanMarkdownForExport, savePlanToWorkspace, validatePlanSavePath } from "./planActions";
import { proposedPlanBody } from "./workLog";

test("the file name comes from the plan's title", () => {
  expect(buildProposedPlanMarkdownFilename("# Ship it, now!\n\nStep")).toBe("ship-it-now.md");
  expect(buildProposedPlanMarkdownFilename("no heading")).toBe("plan.md");
  expect(normalizePlanMarkdownForExport("a\n\n\n")).toBe("a\n");
});

test("a plan folds past 900 characters or 20 lines", () => {
  expect(canCollapsePlan("short")).toBe(false);
  expect(canCollapsePlan("x".repeat(901))).toBe(true);
  expect(canCollapsePlan(Array.from({ length: 21 }, () => "a").join("\n"))).toBe(true);
});

test("the displayed plan drops its title and a leading Summary heading", () => {
  expect(proposedPlanBody("# Title\n\n## Summary\n\nBody")).toBe("Body");
  expect(proposedPlanBody("# Title\n\n## Steps\n\nBody")).toBe("## Steps\n\nBody");
});

test("save paths stay inside the workspace", () => {
  expect(validatePlanSavePath(" docs/plan.md ")).toEqual({ path: "docs/plan.md" });
  expect(validatePlanSavePath("")).toEqual({ error: "Enter a workspace path" });
  expect(validatePlanSavePath("/etc/plan.md")).toEqual({ error: "Enter a path inside the workspace" });
  expect(validatePlanSavePath("a/../../b.md")).toEqual({ error: "Enter a path inside the workspace" });
});

test("saving writes the exported markdown through projects.writeFile", async () => {
  const calls: unknown[] = [];
  const saved = await savePlanToWorkspace({ request: async (method, payload) => { calls.push([method, payload]); return { relativePath: "docs/plan.md" }; } }, "/w", "docs/plan.md", "# T\n\nB");
  expect(saved).toBe("docs/plan.md");
  expect(calls).toEqual([["projects.writeFile", { cwd: "/w", relativePath: "docs/plan.md", contents: "# T\n\nB\n" }]]);
});

test("fm13: a folded plan previews its first visible lines then ...; an empty body falls back to the title or copy", () => {
  const plan = ["# Ship it", "", ...Array.from({ length: 12 }, (_, i) => `- step ${i + 1}`)].join("\n");
  const preview = collapsedPlanPreview(plan, 10).split("\n");
  expect(preview.length).toBe(12);
  expect(preview[9]).toBe("- step 10");
  expect(preview.slice(-2)).toEqual(["", "..."]);
  expect(collapsedPlanPreview("# Only a title")).toBe("Only a title");
  expect(collapsedPlanPreview("   ")).toBe("Plan preview unavailable.");
});
