// client-runtime state/threadRequests.ts + chat/composerSend.logic.ts: the approval rules shared by the
// open thread's approval rows, the child-thread approval cards and a send made over pending approvals.

export const FULL_ACCESS_OVERRIDE_QUESTION = "Why am I being asked this?";

export function fullAccessOverrideExplanation(override: string): string {
  return override === "ask_rule"
    ? "Full access skips approvals, but an ask rule in the agent's own settings matches this action, so it still asks. Remove or narrow that rule to stop these prompts."
    : "Full access skips approvals, but the agent still stops for a few safety checks of its own that no setting can skip, such as a delete whose path it can't verify. T3 Code can't turn these off, so check the request and approve it if it's what you expect.";
}

/** Why a message sent over pending approvals did not go out, or null to stop quietly. */
export function approvalRedirectNotice(input: {
  readonly draftChanged: boolean;
  readonly declined: boolean;
  readonly approvalResponding: boolean;
  readonly approvalArrived: boolean;
}): string | null {
  if (input.draftChanged) {
    return input.declined
      ? "Approval declined. Your message changed, so it wasn't sent."
      : "Your message changed, so it wasn't sent.";
  }
  if (input.approvalResponding) {
    return "An approval is already being answered, so your message wasn't sent.";
  }
  if (input.declined && input.approvalArrived) {
    return "Another approval arrived, so your message wasn't sent.";
  }
  return null;
}

export interface RedirectApproval {
  readonly id: string;
  readonly responseCapability?: "live" | "not_resumable";
  readonly supportsFeedback?: boolean;
}

/** Answers ok when the decline (or feedback) reached the server. */
export type ApprovalResponder = (requestId: string, decision: "decline", feedback?: string) => Promise<boolean>;

/** threadRequests.ts sendApprovalFeedback: a live approval that takes feedback declines with the composer text. */
export async function sendApprovalFeedback(approval: RedirectApproval, feedback: string, respond: ApprovalResponder): Promise<boolean> {
  if (!approval.supportsFeedback || approval.responseCapability === "not_resumable" || !feedback.trim()) return false;
  return respond(approval.id, "decline", feedback.trim());
}

/** threadRequests.ts declinePendingApprovals: declines every approval a redirect replaces. */
export async function declinePendingApprovals(approvals: readonly RedirectApproval[], respond: ApprovalResponder): Promise<boolean> {
  for (const approval of approvals) {
    // A request the provider can no longer answer has nothing to decline.
    if (approval.responseCapability === "not_resumable") continue;
    if (!(await respond(approval.id, "decline"))) return false;
  }
  return true;
}

export interface ApprovalRedirectDeps {
  /** The approvals pending on the thread right now. */
  pending: () => readonly RedirectApproval[];
  /** Ids of approvals whose answer is in flight. */
  responding: () => readonly string[];
  /** The draft (text and attachment ids) as it is now, to tell whether it changed since the send. */
  draftKey: () => string;
  respond: ApprovalResponder;
  /** Clears the composer after approval feedback went out. */
  clearDraft: () => void;
  setError: (message: string) => void;
  toast: (title: string, description: string) => void;
}

/**
 * useComposerSend.ts:916-1050. Returns true when the message should now be sent (every shown approval was
 * declined and nothing changed), false when the send stops here (feedback sent, or a notice explains why not).
 */
export async function redirectPendingApprovals(input: {
  readonly shown: readonly RedirectApproval[];
  readonly message: string;
  readonly hasAttachmentsOrContext: boolean;
}, deps: ApprovalRedirectDeps): Promise<boolean> {
  const { shown } = input;
  const feedbackTarget = shown[0]?.supportsFeedback ? shown[0] : undefined;
  if (shown.length === 0) return true;
  const draftAtSend = deps.draftKey();
  const changed = () => deps.draftKey() !== draftAtSend;
  const pendingBefore = deps.pending().map((approval) => approval.id);
  const approvalResponding = shown.some((approval) => deps.responding().includes(approval.id));
  if (feedbackTarget) {
    if (input.hasAttachmentsOrContext) {
      deps.setError("Send approval feedback without attachments or added context.");
      return false;
    }
    if (approvalResponding) return false;
    const sent = await sendApprovalFeedback(feedbackTarget, input.message, deps.respond).catch(() => false);
    if (sent && !changed()) deps.clearDraft();
    return false;
  }
  const declined = !approvalResponding && (await declinePendingApprovals(shown, deps.respond).catch(() => false));
  const draftChanged = changed();
  // An approval that arrived during the decline would block the redirect; keep the draft so the next send declines it too.
  const approvalArrived = deps.pending().some((approval) => !pendingBefore.includes(approval.id));
  if (!declined || draftChanged || approvalArrived) {
    const notice = approvalRedirectNotice({ draftChanged, declined, approvalResponding, approvalArrived });
    if (notice !== null) deps.toast(notice, "Send again when it's ready.");
    return false;
  }
  return true;
}
