// The Edit from here flow's state: the confirm dialog, the pending flag and the last failure.
// useTimelineRewind.ts keeps the same three pieces in the composer draft store.
import { effect, signal } from "nsh";
import {
  addAttachment, attachmentCapabilities, backendConnectionGeneration, backendUrl, composerDraft, draftAttachments,
  backendStatus, isSending, rawProviderRecords, selectedModel, isServerThread, openThread, requestBackend, setComposerDraft, setThreadError, threadMessages,
} from "../../store";
import { record } from "../../backend/client";
import { serverEnvironmentLabel } from "../banners/serverCaps";
import { mergeRestoredPrompt, rewindableMessageIds, rewindBlockedReason, rewindToMessage } from "./rewind";

/** useTimelineRewind's setThreadError: a failed rewind shows in the thread's error banner. */
const failRewind = (threadId: string | undefined, message: string) => { if (threadId) setThreadError(threadId, message); };
const scopeKey = () => JSON.stringify([backendUrl(), backendConnectionGeneration(), openThread()?.id ?? ""]);

export const rewindConfirm = signal<{ messageId: string; scope: string } | null>(null);
export const rewindPending = signal(false);
export const rewindError = signal<{ scope: string; message: string } | null>(null);

export const rewindFailure = () => (rewindError()?.scope === scopeKey() ? rewindError()?.message ?? null : null);

/** The pencil on a user message: asks first, as the web's RevertConfirmHost does. */
export function requestRewind(messageId: string): void {
  if (rewindPending()) return;
  const provider = selectedModel()?.provider;
  const record = rawProviderRecords().find((item) => item.instanceId === provider);
  const blocked = rewindBlockedReason(openThread(), backendStatus() === "connected", isSending(), record?.supportsConversationRollback !== false, serverEnvironmentLabel());
  if (blocked) {
    rewindError.set({ scope: scopeKey(), message: blocked });
    failRewind(openThread()?.id, blocked);
    return;
  }
  rewindError.set(null);
  rewindConfirm.set({ messageId, scope: scopeKey() });
}

export function cancelRewind(): void {
  rewindConfirm.set(null);
}

export async function confirmRewind(restoreFiles: boolean): Promise<void> {
  const pending = rewindConfirm();
  rewindConfirm.set(null);
  if (!pending || rewindPending() || pending.scope !== scopeKey()) return;
  const message = threadMessages().find((entry) => entry.id === pending.messageId);
  if (!message) return;
  rewindPending.set(true);
  rewindError.set(null);
  const threadId = openThread()?.id;
  try {
    const result = await rewindToMessage({
      message,
      restoreFiles,
      composerBusy: draftAttachments().some((item) => item.status === "uploading"),
      composerAttachmentCount: draftAttachments().length,
      maxAttachments: attachmentCapabilities().maxCount,
    });
    if (pending.scope !== scopeKey()) return;
    setComposerDraft(mergeRestoredPrompt(composerDraft(), result.prompt));
    for (const file of result.files) {
      try { await addAttachment(file); }
      catch (cause) {
        const failure = cause instanceof Error ? cause.message : "Could not restore an attachment to the composer.";
        rewindError.set({ scope: pending.scope, message: failure });
        failRewind(threadId, failure);
      }
    }
  } catch (cause) {
    const failure = cause instanceof Error ? cause.message : "Failed to revert thread state.";
    rewindError.set({ scope: pending.scope, message: failure });
    failRewind(threadId, failure);
  } finally {
    rewindPending.set(false);
  }
}

const rewindable = signal<{ scope: string; ids: Set<string> }>({ scope: "", ids: new Set() });

/** Edit from here shows only on messages the thread can actually be rewound to. */
export const isRewindable = (messageId: string) => rewindable().scope === scopeKey() && rewindable().ids.has(messageId);

/** Reads the projection while the thread is idle and records which user messages have a restorable checkpoint. */
export function trackRewindable(): void {
  // What the answer depends on, as one string: the open thread's object is replaced on every shell update (a visit, an
  // import, another thread's change), and reading the projection each time put a new slow request on the server per update.
  let askedFor = "";
  let reading = false;
  let again = false;
  const read = (threadId: string, scope: string, key: string) => {
    if (reading) { again = true; return; }
    reading = true;
    askedFor = key;
    void requestBackend("orchestration.getThreadProjection", { threadId }).then((value) => {
      const projection = record(value);
      if (openThread()?.id === threadId && projection && record(projection.thread)?.id === threadId) rewindable.set({ scope, ids: rewindableMessageIds(projection) });
    }).catch(() => { askedFor = ""; }).finally(() => {
      reading = false;
      if (again) { again = false; check(); }
    });
  };
  const check = () => {
    const thread = openThread();
    const scope = scopeKey();
    const connected = backendStatus() === "connected";
    const count = threadMessages().length;
    if (!thread || !connected || !isServerThread(thread.id)) return;
    if (thread.status === "running" || thread.status === "awaiting") return;
    const key = `${scope}|${thread.id}|${thread.status}|${count}`;
    if (key === askedFor) return;
    read(thread.id, scope, key);
  };
  effect(check);
}
