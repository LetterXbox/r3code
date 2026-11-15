// useThreadTerminalActions.launchTerminal: a new terminal gets the thread's worktree path and the
// project runtime env (packages/shared projectScripts.ts projectScriptRuntimeEnv):
// T3CODE_PROJECT_ROOT, and T3CODE_WORKTREE_PATH when the thread has a worktree.

export function projectScriptRuntimeEnv(input: { projectRoot: string; worktreePath: string | null; extraEnv?: Record<string, string> }): Record<string, string> {
  const env: Record<string, string> = { T3CODE_PROJECT_ROOT: input.projectRoot };
  if (input.worktreePath) env.T3CODE_WORKTREE_PATH = input.worktreePath;
  return input.extraEnv ? { ...env, ...input.extraEnv } : env;
}

/** The extra terminal.attach fields (TerminalAttachInput.worktreePath / env) for a thread's terminal. */
export function terminalLaunchFields(input: { projectRoot: string | null | undefined; worktreePath: string | null | undefined }): { worktreePath?: string; env?: Record<string, string> } {
  const worktreePath = input.worktreePath?.trim() ? input.worktreePath : null;
  const projectRoot = input.projectRoot?.trim() ? input.projectRoot : null;
  return {
    ...(worktreePath !== null ? { worktreePath } : {}),
    ...(projectRoot !== null ? { env: projectScriptRuntimeEnv({ projectRoot, worktreePath }) } : {}),
  };
}

/** TerminalOpenInput for a terminal's first attach (useThreadTerminalActions.openTerminal): the project's runtime env with a
 * project script's extra env on top, and stopOnSettle when the script asks for it. */
export function terminalOpenInput(input: {
  threadId: string; terminalId: string; cwd: string; size: { cols: number; rows: number };
  location: { worktreePath?: string; env?: Record<string, string> };
  launch: { stopOnSettle?: boolean; env?: Record<string, string> };
}): Record<string, unknown> {
  const env = { ...(input.location.env ?? {}), ...(input.launch.env ?? {}) };
  return {
    threadId: input.threadId, terminalId: input.terminalId, cwd: input.cwd,
    ...(input.location.worktreePath ? { worktreePath: input.location.worktreePath } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...input.size,
    ...(input.launch.stopOnSettle ? { stopOnSettle: true } : {}),
  };
}
