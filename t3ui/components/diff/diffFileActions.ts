// diffFileActions.ts: a diff's file path as a workspace-relative path the Files tab can open, or null when it is
// outside the workspace. The port's diff panel knows the workspace (cwd), not a separate repository root, so a
// repository-relative path is taken as workspace-relative (the reference's case when both roots are the same).

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function relativeSegments(filePath: string): string[] | null {
  if (filePath.startsWith("/") || /^[a-zA-Z]:/.test(filePath)) return null;
  const segments = filePath.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;
  return segments;
}

export function resolveDiffPathForWorkspace(input: { filePath: string; workspaceRoot: string | null | undefined; repositoryRoot?: string | null }): string | null {
  // Claude and ACP tool-call diffs name files by absolute path.
  if (isAbsolutePath(input.filePath)) {
    const rawRoot = input.workspaceRoot ?? "";
    const caseInsensitive = isWindowsPath(rawRoot);
    const root = rawRoot.replaceAll("\\", "/").replace(/\/+$/, "");
    const path = input.filePath.replaceAll("\\", "/");
    const fold = (value: string) => (caseInsensitive ? value.toLowerCase() : value);
    if (!root || !fold(path).startsWith(`${fold(root)}/`)) return null;
    const segments = relativeSegments(path.slice(root.length + 1));
    return segments ? segments.join("/") : null;
  }
  const fileSegments = relativeSegments(input.filePath);
  if (!fileSegments) return null;
  const workspaceSegments = repositoryRelativeWorkspaceSegments(input.workspaceRoot, input.repositoryRoot);
  // No usable roots, or a workspace outside the repository: the path is taken as workspace-relative.
  if (!workspaceSegments || workspaceSegments.length === 0) return fileSegments.join("/");
  const caseInsensitive = input.repositoryRoot ? isWindowsPath(input.repositoryRoot) : false;
  const belongs = workspaceSegments.every((segment, index) => {
    const candidate = fileSegments[index];
    if (candidate === undefined) return false;
    return caseInsensitive ? candidate.toLowerCase() === segment : candidate === segment;
  });
  if (!belongs) return null;
  const rest = fileSegments.slice(workspaceSegments.length);
  return rest.length > 0 ? rest.join("/") : null;
}

function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** normalizeProjectPathForComparison: Windows roots compare lowercased with backslashes. */
function comparablePath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return isWindowsPath(trimmed) ? trimmed.replaceAll("/", "\\").toLowerCase() : trimmed;
}

function repositoryRelativeWorkspaceSegments(workspaceRoot: string | null | undefined, repositoryRoot: string | null | undefined): string[] | null {
  if (!workspaceRoot || !repositoryRoot) return null;
  const workspace = comparablePath(workspaceRoot);
  const repository = comparablePath(repositoryRoot);
  if (workspace === repository) return [];
  const separator = repository.includes("\\") ? "\\" : "/";
  const prefix = repository.endsWith(separator) ? repository : `${repository}${separator}`;
  if (!workspace.startsWith(prefix)) return null;
  return workspace.slice(prefix.length).split(/[\\/]+/).filter(Boolean);
}
