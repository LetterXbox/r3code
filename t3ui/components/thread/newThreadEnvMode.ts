// packages/shared projectSettings.ts resolveProjectSettings (project file tier) + resolveNewThreadEnvMode, and
// useHandleNewThread.ts's call: where a new thread starts. A project override (stored, else legacy) wins; then the
// environment's setting; when that is unset (null) the repository's t3.json `defaultThreadEnvMode` applies, else the
// built-in "local". A project made under the server's new-projects root starts in its checkout until its first thread,
// unless the mode came from the project or its t3.json.
import { parseLenientJson } from "../header/t3ProjectFile";

export type ThreadEnvMode = "local" | "worktree";
export type EnvModeSource = "project" | "environment" | "t3.json";

const isEnvMode = (value: unknown): value is ThreadEnvMode => value === "local" || value === "worktree";

/** t3.json's defaultThreadEnvMode, or undefined when the file or the field is absent or invalid. */
export function projectFileEnvMode(contents: string | null): ThreadEnvMode | undefined {
  if (contents === null) return undefined;
  try {
    const parsed = parseLenientJson(contents) as Record<string, unknown> | null;
    const value = parsed && typeof parsed === "object" ? parsed.defaultThreadEnvMode : undefined;
    return isEnvMode(value) ? value : undefined;
  } catch { return undefined; }
}

/** The configured mode and where it came from; `readFile` is consulted only when nothing above the file sets it. */
export async function resolveConfiguredEnvMode(input: { override: unknown; environment: unknown; readFile: () => Promise<string | null> }): Promise<{ mode: ThreadEnvMode; source: EnvModeSource }> {
  if (isEnvMode(input.override)) return { mode: input.override, source: "project" };
  if (isEnvMode(input.environment)) return { mode: input.environment, source: "environment" };
  let contents: string | null = null;
  try { contents = await input.readFile(); } catch { contents = null; }
  const fromFile = projectFileEnvMode(contents);
  return fromFile === undefined ? { mode: "local", source: "environment" } : { mode: fromFile, source: "t3.json" };
}

const isWindowsLike = (value: string) => /^[a-zA-Z]:([/\\]|$)/.test(value) || value.startsWith("\\\\");
function normalizeForComparison(value: string): string {
  let trimmed = value.trim();
  const isRoot = trimmed === "/" || /^[a-zA-Z]:[/\\]?$/.test(trimmed);
  if (!isRoot && trimmed.length > 0) {
    const next = trimmed.startsWith("/") ? trimmed.replace(/\/+$/g, "") : trimmed.replace(/[\\/]+$/g, "");
    if (next.length > 0) trimmed = next;
  }
  return isWindowsLike(trimmed) ? trimmed.replaceAll("/", "\\").toLowerCase() : trimmed;
}

/** resolveNewThreadEnvMode: new name-only projects use their checkout until the first thread, even when the default is worktree. */
export function resolveNewThreadEnvMode(input: { mode: ThreadEnvMode; source: EnvModeSource; workspaceRoot: string | null; newProjectsRoot: string | null | undefined; projectHasThreads: boolean }): ThreadEnvMode {
  if (input.mode === "local" || input.projectHasThreads || input.source !== "environment" || input.workspaceRoot === null || input.newProjectsRoot == null) return input.mode;
  const root = normalizeForComparison(input.newProjectsRoot);
  const folder = normalizeForComparison(input.workspaceRoot);
  const separator = root.includes("\\") ? "\\" : "/";
  const prefix = root.endsWith(separator) ? root : `${root}${separator}`;
  const isNewProjectFolder = folder.startsWith(prefix) && folder.length > prefix.length && !folder.slice(prefix.length).includes(separator);
  return isNewProjectFolder ? "local" : input.mode;
}
