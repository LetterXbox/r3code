export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export type InteractionMode = "default" | "plan";
export type WorkspaceStrategy =
  | { type: "root"; branch?: string }
  | { type: "existing_worktree"; worktreePath: string; branch?: string }
  | { type: "worktree"; baseRef: string; branch?: string; startFromOrigin?: boolean };

export const RUNTIME_MODES: RuntimeMode[] = ["approval-required", "auto-accept-edits", "auto", "full-access"];
export function isRuntimeMode(value: unknown): value is RuntimeMode {
  return value === "approval-required" || value === "auto-accept-edits" || value === "auto" || value === "full-access";
}
export function isInteractionMode(value: unknown): value is InteractionMode {
  return value === "default" || value === "plan";
}
export function validWorkspaceStrategy(value: WorkspaceStrategy): WorkspaceStrategy {
  const branch = value.branch?.trim();
  if (value.branch !== undefined && !branch) throw new Error("Enter a branch name or leave it empty");
  if (value.type === "root") return { type: "root", ...(branch ? { branch } : {}) };
  if (value.type === "existing_worktree") {
    const worktreePath = value.worktreePath.trim();
    if (!worktreePath) throw new Error("Choose a worktree path");
    return { type: "existing_worktree", worktreePath, ...(branch ? { branch } : {}) };
  }
  const baseRef = value.baseRef.trim();
  if (!baseRef) throw new Error("Choose a base branch for the worktree");
  return { type: "worktree", baseRef, ...(branch ? { branch } : {}), ...(value.startFromOrigin === undefined ? {} : { startFromOrigin: value.startFromOrigin }) };
}
