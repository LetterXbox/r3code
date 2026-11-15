// The thread a view works on. The main view is in the open thread's scope (the default); a side chat pane
// provides its child thread's scope, so the transcript, composer, queue and request panels inside it read and
// write that thread (the reference passes a threadId into ChatView / ChatComposer / MessagesTimeline).
import { context } from "nsh";
import type { ActivityItem, DraftAttachment, Message, PendingApproval, PendingUserInput, Thread } from "../../store";
import {
  composerDraft,
  composerDraftFor,
  draftAttachmentFile,
  draftAttachmentFileFor,
  draftAttachments,
  draftAttachmentsFor,
  isSending,
  isSendingFor,
  openThread,
  threadActiveRunId,
  threadActiveRunIdFor,
  threadActivity,
  threadActivityFor,
  threadApprovals,
  threadApprovalsFor,
  threadById,
  threadMessages,
  threadMessagesFor,
  threadRuns,
  threadRunsFor,
  threadUserInputs,
  threadUserInputsFor,
  threadWorkFor,
  threadWorking,
  threadWorkStartedAt,
  withThreadScope,
} from "../../store";

export interface ThreadScopeValue {
  /** True for a side chat pane; the main view is the open thread's scope. */
  readonly scoped: boolean;
  thread: () => Thread | undefined;
  messages: () => Message[];
  activity: () => ActivityItem[];
  approvals: () => PendingApproval[];
  userInputs: () => PendingUserInput[];
  runs: () => Record<string, unknown>[];
  working: () => boolean;
  workStartedAt: () => number | null;
  activeRunId: () => string | null;
  draft: () => string;
  isSending: () => boolean;
  draftAttachments: () => DraftAttachment[];
  draftAttachmentFile: (attachmentId: string) => File | undefined;
  /** Runs a store action (setComposerDraft, sendDraft, stopThread, respondToApproval ...) for this thread. */
  run: <T>(action: () => T) => T;
}

export const openThreadScope: ThreadScopeValue = {
  scoped: false,
  thread: openThread,
  messages: () => threadMessages(),
  activity: () => threadActivity(),
  approvals: () => threadApprovals(),
  userInputs: () => threadUserInputs(),
  runs: threadRuns,
  working: threadWorking,
  workStartedAt: threadWorkStartedAt,
  activeRunId: threadActiveRunId,
  draft: composerDraft,
  isSending,
  draftAttachments,
  draftAttachmentFile,
  run: (action) => action(),
};

/** The scope of one thread shown beside the open thread (its subscription is held by retainThread). */
export function threadScopeFor(threadId: string): ThreadScopeValue {
  return {
    scoped: true,
    thread: () => threadById(threadId),
    messages: () => threadMessagesFor(threadId),
    activity: () => threadActivityFor(threadId),
    approvals: () => threadApprovalsFor(threadId),
    userInputs: () => threadUserInputsFor(threadId),
    runs: () => threadRunsFor(threadId),
    working: () => threadWorkFor(threadId).working,
    workStartedAt: () => threadWorkFor(threadId).startedAt,
    activeRunId: () => threadActiveRunIdFor(threadId),
    draft: () => composerDraftFor(threadId),
    isSending: () => isSendingFor(threadId),
    draftAttachments: () => draftAttachmentsFor(threadId),
    draftAttachmentFile: (attachmentId) => draftAttachmentFileFor(threadId, attachmentId),
    run: (action) => withThreadScope(threadId, action),
  };
}

export const ThreadScope = context<ThreadScopeValue>(openThreadScope);

/** The thread in scope where this is called (the open thread outside a side chat). */
export const useThreadScope = () => ThreadScope();
