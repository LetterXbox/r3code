// client-runtime subagentDisplay.ts resolveSubagentMetadata's workspace rows: the child's project when it differs from
// the parent's, and its worktree or workspace (by folder name) when it runs somewhere other than the parent.
interface ThreadLike { projectId: string; path?: string; branch?: string }
interface ProjectLike { id: string; name: string; path?: string }

const basename = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

export function subagentWorkspaceRows(parent: ThreadLike | null | undefined, child: ThreadLike | null | undefined, projects: readonly ProjectLike[]): { label: string; value: string }[] {
  const project = (id: string | undefined) => (id ? projects.find((item) => item.id === id) : undefined);
  const childProject = project(child?.projectId);
  const parentWorkspace = parent?.path ?? project(parent?.projectId)?.path;
  const childWorkspace = child?.path ?? childProject?.path;
  return [
    ...(parent && childProject && childProject.id !== parent.projectId ? [{ label: "Project", value: childProject.name }] : []),
    ...(parentWorkspace && childWorkspace && parentWorkspace !== childWorkspace ? [{ label: child?.branch ? "Branch" : child?.path ? "Worktree" : "Workspace", value: child?.branch ?? basename(childWorkspace) }] : []),
  ];
}
