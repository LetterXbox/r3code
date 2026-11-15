// Plan card helpers, ported from proposedPlan.ts and chat/ProposedPlanCard.tsx.
import { homedir } from "os";
import { writeFile } from "fs/promises";
import { proposedPlanBody, proposedPlanTitle } from "./workLog";

function sanitizePlanFileSegment(input: string): string {
  const sanitized = input
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}]+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "plan";
}

export function buildProposedPlanMarkdownFilename(planMarkdown: string): string {
  return `${sanitizePlanFileSegment(proposedPlanTitle(planMarkdown) ?? "plan")}.md`;
}

export function normalizePlanMarkdownForExport(planMarkdown: string): string {
  return `${planMarkdown.trimEnd()}\n`;
}

/** buildCollapsedProposedPlanPreviewMarkdown (proposedPlan.ts:3-43): the folded card shows the first `maxLines` visible
 * lines (the card asks for 10), then "..." when more follows; with no body, the plan's title or "Plan preview unavailable.". */
export function collapsedPlanPreview(planMarkdown: string, maxLines = 8): string {
  const lines = proposedPlanBody(planMarkdown).trimEnd().split(/\r?\n/).map((line) => line.trimEnd());
  const preview: string[] = [];
  let visible = 0;
  let more = false;
  for (const line of lines) {
    const isVisible = line.trim().length > 0;
    if (isVisible && visible >= maxLines) { more = true; break; }
    preview.push(line);
    if (isVisible) visible += 1;
  }
  while (preview.length > 0 && preview.at(-1)?.trim().length === 0) preview.pop();
  if (preview.length === 0) return proposedPlanTitle(planMarkdown) ?? "Plan preview unavailable.";
  if (more) preview.push("", "...");
  return preview.join("\n");
}

/** A long plan folds behind a fade and an Expand plan button. */
export function canCollapsePlan(planMarkdown: string): boolean {
  return planMarkdown.length > 900 || planMarkdown.split("\n").length > 20;
}

/** The server resolves the path inside the workspace; refuse anything that clearly leaves it. */
export function validatePlanSavePath(input: string): { path: string } | { error: string } {
  const path = input.trim();
  if (!path) return { error: "Enter a workspace path" };
  if (path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.split(/[\\/]/).includes("..")) {
    return { error: "Enter a path inside the workspace" };
  }
  return { path };
}

type SaveDependencies = { request: (method: string, payload: unknown) => Promise<unknown> };

/** projects.writeFile: the web's "Save to workspace" action. */
export async function savePlanToWorkspace(deps: SaveDependencies, workspaceRoot: string, relativePath: string, planMarkdown: string): Promise<string> {
  const checked = validatePlanSavePath(relativePath);
  if ("error" in checked) throw new Error(checked.error);
  const result = await deps.request("projects.writeFile", { cwd: workspaceRoot, relativePath: checked.path, contents: normalizePlanMarkdownForExport(planMarkdown) });
  const saved = result && typeof result === "object" && "relativePath" in result ? (result as { relativePath: unknown }).relativePath : null;
  return typeof saved === "string" && saved ? saved : checked.path;
}

/** The desktop has no browser download: write the markdown into ~/Downloads. */
export async function downloadPlanMarkdown(filename: string, planMarkdown: string): Promise<string> {
  const target = `${homedir()}/Downloads/${filename}`;
  await writeFile(target, normalizePlanMarkdownForExport(planMarkdown));
  return target;
}
