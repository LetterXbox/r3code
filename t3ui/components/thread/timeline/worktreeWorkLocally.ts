// ChatView.tsx onWorktreeSetupWorkLocally / workLocallyResend: "Work locally" on a draft whose worktree setup is still
// running cancels the setup (`worktreeSetup.cancel`); once the cancelled launch has handed the message back to the draft
// and sending is idle, the draft switches to local (root, no startFromOrigin) and the waiting message is sent again.
import { signal } from "nsh";

/** The draft whose message waits to be re-sent locally (workLocallyResendDraftId). */
export const workLocallyResendDraftId = signal<string | null>(null);

export async function workLocally(input: { draftId: string | null; setupRunning: boolean; threadId: string; send: (method: string, payload: unknown) => Promise<unknown> }): Promise<boolean> {
  if (!input.setupRunning || !input.draftId) return false;
  try {
    const result = await input.send("worktreeSetup.cancel", { threadId: input.threadId }) as { cancelled?: unknown } | null;
    if (result?.cancelled !== true) return false;
  } catch { return false; }
  workLocallyResendDraftId.set(input.draftId);
  return true;
}

/**
 * One step of the resend effect: "wait" while not ready, "switch" when the draft is still on a worktree (the caller sets
 * root and the effect runs again), "send" when it is local (the caller clears the request and sends).
 */
export function workLocallyStep(input: { pendingDraftId: string | null; draftId: string | null; isDraft: boolean; sending: boolean; connected: boolean; workspaceType: string }): "wait" | "switch" | "send" {
  if (input.pendingDraftId === null || input.pendingDraftId !== input.draftId || !input.isDraft || input.sending || !input.connected) return "wait";
  return input.workspaceType !== "root" ? "switch" : "send";
}
