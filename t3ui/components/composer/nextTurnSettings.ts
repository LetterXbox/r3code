// persistThreadSettingsForNextTurn (ChatView.tsx) with resolveThreadMetadataUpdateForNextTurn: before a server
// thread's turn starts, the thread takes the composer's branch (a local checkout that moved) and permission and
// interaction modes, so the turn runs with what the composer shows. Returns the commands to dispatch, in order.
export interface NextTurnSettingsInput {
  threadId: string;
  /** The thread as the server holds it. */
  server: { runtime: string; interaction: string; branch: string | null };
  /** What the composer holds. */
  runtime: string;
  interaction: string;
  /** localCheckoutBranchMismatch.currentBranch: the checkout's branch when it differs from the thread's. */
  checkoutBranch?: string | null;
}

export function nextTurnSettingsCommands(input: NextTurnSettingsInput): Record<string, unknown>[] {
  const commands: Record<string, unknown>[] = [];
  if (input.checkoutBranch && input.checkoutBranch !== input.server.branch) {
    commands.push({ type: "thread.metadata.update", threadId: input.threadId, branch: input.checkoutBranch, worktreePath: null });
  }
  if (input.runtime !== input.server.runtime) commands.push({ type: "thread.runtime-mode.set", threadId: input.threadId, runtimeMode: input.runtime });
  if (input.interaction !== input.server.interaction) commands.push({ type: "thread.interaction-mode.set", threadId: input.threadId, interactionMode: input.interaction });
  return commands;
}
