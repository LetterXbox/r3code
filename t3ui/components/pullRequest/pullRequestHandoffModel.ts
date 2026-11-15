// "Ask a question", "Explain this PR" and "Resolve conflicts": each opens a new thread in the pull request's project
// with the composer holding the task (startAsk / startHandoff in PullRequestDetailPanel.tsx). Resolving conflicts
// checks the branch out in a worktree first.
import { signal } from "nsh";
import { changeRequestTerm } from "./pullRequestCheckout.logic";
import { pullRequestHandoffLabels, buildAskAboutGuideStopDraft, buildAddSelectionDraft, buildAskDraft, buildFixFindingDraft, buildFixFindingsDraft, findingKey, type PullRequestFinding, buildExplainDraft, buildResolveConflictsPrompt, type HandoffSubject } from "./pullRequestHandoff.logic";

export function createPullRequestHandoffModel(deps: {
  subject: () => (HandoffSubject & { projectId: string }) | null;
  /** Opens a new thread in the project (null when it could not). */
  newThread: (projectId: string) => string | null;
  setDraft: (text: string) => void;
  /** The worktree checkout; resolves true once the thread sits on the branch. */
  checkout: (mode: "worktree", withTask: boolean) => Promise<boolean>;
  toast: (input: { type: "success" | "error"; title: string; description?: string }) => void;
  /** composerDraftTarget: the detail sits beside a thread's composer, so a handoff goes into that composer instead of a new thread. */
  attach?: () => boolean;
}) {
  const attached = () => deps.attach?.() === true;
  /** "Added to the composer" (startAsk / startHandoff with an attach target). */
  function addToComposer(text: string, description: string): boolean {
    deps.setDraft(text);
    deps.toast({ type: "success", title: "Added to the composer", description });
    return true;
  }
  const TASK_IN_COMPOSER = "The task is in the composer. Read it over, then send.";
  /** "ask", "explain" or "conflicts" while one is running. */
  const handoff = signal<string | null>(null);

  function open(kind: "ask" | "explain" | "selection", draftOf: (subject: HandoffSubject) => string, done: string | ((subject: HandoffSubject) => string)): boolean {
    const subject = deps.subject();
    if (!subject || handoff() !== null) return false;
    if (attached()) {
      return addToComposer(draftOf(subject), kind === "ask" ? `The ${changeRequestTerm(subject.provider)} is in the composer. Type your question, then send.` : "The question is in the composer. Read it over, then send.");
    }
    handoff.set(kind);
    const threadId = deps.newThread(subject.projectId);
    if (threadId === null) {
      handoff.set(null);
      deps.toast({ type: "error", title: "Could not open a thread", description: "Try again from the project, or open a thread first." });
      return false;
    }
    deps.setDraft(draftOf(subject));
    handoff.set(null);
    deps.toast({ type: "success", title: "Asked in a thread", description: typeof done === "string" ? done : done(subject) });
    return true;
  }

  return {
    handoff,
    /** pullRequestHandoffLabels: beside a composer the fixes say "in this thread". */
    labels: () => pullRequestHandoffLabels(attached()),
    attached,
    ask: () => open("ask", buildAskDraft, (subject) => `The ${changeRequestTerm(subject.provider)} is in the composer. Type your question, then send.`),
    explain: () => open("explain", buildExplainDraft, "The question is in the composer. Read it over, then send."),
    /** "Add to agent" from the Code tab: the request and the selected lines go to a new thread's composer. */
    /** "Ask about this stop" and a stop's questions on the Guide tab: the stop and the question go to a new thread's composer. */
    askAboutStop: (stop: Parameters<typeof buildAskAboutGuideStopDraft>[1], question: string) => open("selection", (subject) => buildAskAboutGuideStopDraft(subject, stop, question), "The question is in the composer. Read it over, then send."),
    addSelection: (selection: Parameters<typeof buildAddSelectionDraft>[1], request: string) => open("selection", (subject) => buildAddSelectionDraft(subject, selection, request), "The question is in the composer. Read it over, then send."),
    /**
     * "Fix" on a finding, or "Fix findings in a thread" (`null`): the branch is checked out in a worktree, then the new thread's
     * composer holds the request (startHandoff in PullRequestDetailPanel). `handoff` names the finding in progress.
     */
    async fix(finding: PullRequestFinding | null, all?: Parameters<typeof buildFixFindingsDraft>[1] & { hostLabel?: string }): Promise<boolean> {
      const subject = deps.subject();
      if (!subject || handoff() !== null) return false;
      const draft = () => (finding === null ? buildFixFindingsDraft(subject, all ?? { reviewThreads: [], comments: [], checks: [], commentsTruncated: false }, all?.hostLabel) : buildFixFindingDraft(subject, finding));
      if (attached()) return addToComposer(draft(), TASK_IN_COMPOSER);
      handoff.set(finding === null ? "findings" : findingKey(finding));
      const ready = await deps.checkout("worktree", true);
      if (ready) deps.setDraft(draft());
      handoff.set(null);
      return ready;
    },
    async resolveConflicts(): Promise<boolean> {
      const subject = deps.subject();
      if (!subject || handoff() !== null) return false;
      if (attached()) return addToComposer(buildResolveConflictsPrompt(subject), TASK_IN_COMPOSER);
      handoff.set("conflicts");
      const ready = await deps.checkout("worktree", true);
      if (ready) deps.setDraft(buildResolveConflictsPrompt(subject));
      handoff.set(null);
      return ready;
    },
  };
}

export type PullRequestHandoffModel = ReturnType<typeof createPullRequestHandoffModel>;
