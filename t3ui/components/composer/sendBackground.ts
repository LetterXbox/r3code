// composer.sendBackground and composer.sendAndNewThread (composerSubmissionIntentForKey's "background" intent,
// useComposerSend): send the prompt, then leave a fresh composer in the same project while the thread works.
// A draft thread says "Started in background" with an Open action; a thread already on the server just
// gets a new thread beside it (handleNewThreadInActiveProject).

export interface BackgroundSendDeps {
  threadId: () => string | undefined;
  projectId: () => string | undefined;
  /** Whether the open thread is a local draft (not on the server yet): composer.sendBackground's route. */
  isDraft: () => boolean;
  canSend: () => boolean;
  /** Sends the prompt as the foreground send does. */
  submit: () => void;
  /** Whether that submit started delivering (a rejected one, a side chat command, started nothing). */
  isSending: () => boolean;
  newThread: (projectId: string) => void;
  open: (threadId: string) => void;
  toast: (input: { type: "success" | "warning"; title: string; description?: string; timeoutMs?: number; actions?: { label: string; run: () => void }[] }) => void;
}

/** True when the prompt went out and a fresh composer opened; false leaves everything as it was. */
export function sendInBackground(deps: BackgroundSendDeps): boolean {
  const id = deps.threadId();
  const projectId = deps.projectId();
  if (!id || !projectId || !deps.canSend()) return false;
  const draft = deps.isDraft();
  deps.submit();
  if (!deps.isSending()) return false;
  // useComposerSend: the prompt is already out; a fresh composer that cannot open says so.
  try {
    deps.newThread(projectId);
  } catch (error) {
    deps.toast({ type: "warning", title: "Could not open a fresh composer", ...(error instanceof Error && error.message ? { description: error.message } : {}) });
    return true;
  }
  if (draft) deps.toast({ type: "success", title: "Started in background", timeoutMs: 5000, actions: [{ label: "Open", run: () => deps.open(id) }] });
  return true;
}

/** composer.sendBackground answers on a draft thread only; composer.sendAndNewThread everywhere else. */
export const sendBackgroundApplies = (command: "composer.sendBackground" | "composer.sendAndNewThread", isDraft: boolean) =>
  command === "composer.sendBackground" ? isDraft : !isDraft;
