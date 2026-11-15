// "Check out": the server prepares the branch (git.preparePullRequestThread), a new thread opens on it, and
// toasts report each step. Ported from startHandoff in PullRequestDetailPanel.tsx (the checkout mode only).
import { signal } from "nsh";
import { checkoutFailureDescription } from "./pullRequestCheckout.logic";
import { offHeadPullRequestCheckoutToast } from "./pullRequestCheckoutToast";

export type CheckoutMode = "worktree" | "local";
export type CheckoutWorkspace = { type: "root"; branch: string } | { type: "existing_worktree"; worktreePath: string; branch: string };

export interface CheckoutToasts {
  show: (input: { type: "loading" | "success" | "error" | "warning"; title: string; description?: string }) => string;
  update: (id: string, input: { type: "loading" | "success" | "error" | "warning"; title: string; description?: string }) => void;
}

export function createPullRequestCheckoutModel(deps: {
  request: (method: string, payload: unknown) => Promise<unknown>;
  /** The pull request being shown, or null. */
  subject: () => { url: string; projectId: string; term: string } | null;
  /** The project's folder on the server. */
  projectPath: (projectId: string) => string | null;
  /** Opens a new thread in the project and returns its id. */
  newThread: (projectId: string) => string | null;
  /** Points the open thread at the checkout. Throws when the thread has already started. */
  selectWorkspace: (workspace: CheckoutWorkspace) => void;
  toasts: CheckoutToasts;
}) {
  /** "checkout:worktree" or "checkout:local" while one is running. */
  const handoff = signal<string | null>(null);

  const root = () => { const subject = deps.subject(); return subject ? deps.projectPath(subject.projectId) : null; };

  /** `withTask`: a handoff (Fix, Resolve conflicts) puts its task in the composer next; the toast then says so ("Checkout ready"). */
  async function start(mode: CheckoutMode, withTask = false): Promise<boolean> {
    const subject = deps.subject();
    const cwd = root();
    if (!subject || cwd === null || handoff() !== null) return false;
    handoff.set(`checkout:${mode}`);
    const toastId = deps.toasts.show({ type: "loading", title: `Preparing the ${subject.term} checkout...` });
    // Checkout setup requires the thread to exist first.
    const threadId = deps.newThread(subject.projectId);
    if (threadId === null) {
      handoff.set(null);
      deps.toasts.update(toastId, { type: "error", title: "Could not open a thread for the checkout", description: "Try again from the project, or open a thread first." });
      return false;
    }
    let prepared: { branch?: unknown; worktreePath?: unknown; isOnPullRequestHead?: unknown } | null;
    try {
      prepared = await deps.request("git.preparePullRequestThread", { cwd, reference: subject.url, mode, threadId }) as typeof prepared;
    } catch (cause) {
      handoff.set(null);
      deps.toasts.update(toastId, { type: "error", title: `Could not prepare the ${subject.term} checkout`, description: checkoutFailureDescription(cause) });
      return false;
    }
    const branch = typeof prepared?.branch === "string" ? prepared.branch : "";
    const worktreePath = typeof prepared?.worktreePath === "string" && prepared.worktreePath ? prepared.worktreePath : null;
    try {
      if (!branch) throw new Error("The server named no branch.");
      deps.selectWorkspace(worktreePath === null ? { type: "root", branch } : { type: "existing_worktree", worktreePath, branch });
    } catch {
      handoff.set(null);
      // Sending after a failed rebinding would use the previous checkout.
      deps.toasts.update(toastId, {
        type: "error",
        title: "Checked out, but the thread stayed where it was",
        description: `The checkout is ready on \`${branch}\`. Point a thread at it from the branch picker, then ask again.`,
      });
      return false;
    }
    handoff.set(null);
    deps.toasts.update(toastId, prepared?.isOnPullRequestHead === false
      ? offHeadPullRequestCheckoutToast(subject.term)
      : withTask ? { type: "success", title: "Checkout ready", description: "The task is in the composer. Read it over, then send." }
      : {
        type: "success",
        title: mode === "local" ? "Checked out here" : "Checked out",
        description: mode === "local"
          ? `This repository is on the ${subject.term}'s branch, with a thread open on it.`
          : `The ${subject.term} is in its own worktree, with a thread open on it.`,
      });
    return true;
  }

  return { handoff, root, start };
}

export type PullRequestCheckoutModel = ReturnType<typeof createPullRequestCheckoutModel>;
