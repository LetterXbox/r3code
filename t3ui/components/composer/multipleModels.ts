// Multiple-model send from a draft (ComposerFooterControls.tsx ComposerModelPicker, composerSend.logic.ts
// multipleModelSendBlock, chatViewSend.ts startFanoutThread, useMultipleModelSend.ts): Shift+click in the model picker
// adds or removes a model; with two or more picked, sending starts one background thread per model, each in its own
// worktree on the draft's base branch.
import { signal } from "nsh";
import type { AvailableModel, ProviderStatus } from "../../store";
import { antigravitySendBlockReason } from "./providerStatusLogic";
import { modelOptionsFor } from "../../store";
import { modelShortName } from "./modelShortName";
import { providerMetaFor } from "./providerCatalog";

export interface FanoutSelection { provider: string; model: string }

/** draftFanoutSelectionsAtom: the models picked for each draft, null while one model is picked. */
const selectionsByDraft = signal<Record<string, FanoutSelection[] | null>>({});
export const fanoutSelectionsFor = (draftId: string | undefined): FanoutSelection[] | null => (draftId ? selectionsByDraft()[draftId] ?? null : null);
export function setFanoutSelections(draftId: string, selections: FanoutSelection[] | null): void {
  selectionsByDraft.update((all) => ({ ...all, [draftId]: selections }));
}

/**
 * toggleModel: adds the model, or removes it when picked; two or more stay a multiple selection, otherwise it ends and
 * the model left (or the current one) becomes the single pick.
 */
export function toggleFanoutModel(current: FanoutSelection[] | null, single: FanoutSelection, provider: string, model: string): { selections: FanoutSelection[] | null; single: FanoutSelection } {
  const list = current ?? [single];
  const exists = list.some((item) => item.provider === provider && item.model === model);
  const next = exists ? list.filter((item) => !(item.provider === provider && item.model === model)) : [...list, { provider, model }];
  if (next.length > 1) return { selections: next, single };
  return { selections: null, single: next[0] ?? single };
}

/** The trigger's label for a multiple selection (ProviderModelPicker multipleLabel). */
export function multipleModelLabel(selections: FanoutSelection[], models: readonly AvailableModel[]): string {
  if (selections.length === 0) return "Choose models";
  const label = (item: FanoutSelection) => {
    const found = models.find((entry) => entry.provider === item.provider && entry.model === item.model);
    if (!found) return item.model;
    const name = found.label.includes(": ") ? found.label.slice(found.label.indexOf(": ") + 2) : found.label;
    return modelShortName(name, found.driver ?? providerMetaFor(found.provider)?.driver ?? null);
  };
  return `${selections.slice(0, 2).map(label).join(", ")}${selections.length > 2 ? `, ${selections.length - 2} more` : ""}`;
}

/** multipleModelSendBlock. */
export function multipleModelSendBlock(input: { selectionCount: number; serverSupportsWorktreeBootstrap: boolean; isLocalDraftThread: boolean; isGitRepo: boolean; branch: string | null }): "server-outdated" | "needs-new-git-thread" | null {
  if (!input.serverSupportsWorktreeBootstrap) return "server-outdated";
  if (!input.isLocalDraftThread || !input.isGitRepo || !input.branch || input.selectionCount === 0) return "needs-new-git-thread";
  return null;
}

/** The send button's refusal while a multiple selection is empty (ChatComposer sendDisabledReason). */
export const multipleModelSendDisabledReason = (selections: FanoutSelection[] | null) => (selections?.length === 0 ? "Select at least one model." : null);

/** The model selection a thread of the send starts with: the model's picked options when it has any. */
export function fanoutModelSelection(item: FanoutSelection): Record<string, unknown> {
  const options = modelOptionsFor(item.provider, item.model);
  return { instanceId: item.provider, model: item.model, ...(options ? { options } : {}) };
}

/** A request that may have reached the server before failing, by retry key: sending again would duplicate its thread. */
const uncertainSubmissions = new Map<string, string>();

export interface FanoutDeps {
  launch: (threadId: string, item: FanoutSelection) => Promise<void>;
  newThreadId: () => string;
  toast: (input: { type: "success" | "error"; title: string; description?: string; actions?: { label: string; run: () => void }[]; timeoutMs?: number }) => void;
  openThread: (threadId: string) => void;
  confirm: (message: string) => Promise<boolean>;
}

/** startFanoutThread: one thread of the send, remembered by `retryKey` when the request may have started. */
export async function startFanoutThread(input: { retryKey: string; item: FanoutSelection; modelLabel: string; deps: FanoutDeps }): Promise<boolean> {
  const uncertain = uncertainSubmissions.get(input.retryKey);
  const threadId = uncertain ?? input.deps.newThreadId();
  let mayHaveStarted = false;
  try {
    if (uncertain) throw new Error("The previous request may have started. Open its thread to check before sending again.");
    mayHaveStarted = true;
    await input.deps.launch(threadId, input.item);
    return true;
  } catch (error) {
    if (mayHaveStarted && !uncertainSubmissions.has(input.retryKey)) uncertainSubmissions.set(input.retryKey, threadId);
    const retained = uncertainSubmissions.get(input.retryKey);
    input.deps.toast({
      type: "error", title: `Could not start ${input.modelLabel}`, description: error instanceof Error ? error.message : "Failed to send message.",
      ...(retained ? {
        timeoutMs: 0,
        actions: [
          { label: "Allow retry", run: () => {
            void input.deps.confirm("The previous request may already be running. Check its thread first. Allow another send that could create a duplicate thread?")
              .then((confirmed) => { if (confirmed && uncertainSubmissions.get(input.retryKey) === retained) uncertainSubmissions.delete(input.retryKey); }, () => undefined);
          } },
          { label: "Open thread", run: () => input.deps.openThread(retained) },
        ],
      } : {}),
    });
    return false;
  }
}

/**
 * useMultipleModelSend: starts every selected model's thread; the draft clears at once, failed models stay selected and
 * the prompt comes back when any fail. Resolves with how many started.
 */
export async function sendMultipleModels(input: {
  draftId: string; selections: FanoutSelection[]; text: string; models: readonly AvailableModel[];
  clearDraft: () => void; restoreDraft: () => void; releaseAttachments: () => void; deps: FanoutDeps;
}): Promise<number> {
  input.clearDraft();
  const failed: FanoutSelection[] = [];
  let started = 0;
  await Promise.all(input.selections.map(async (item) => {
    const ok = await startFanoutThread({ retryKey: JSON.stringify([input.draftId, item.provider, item.model]), item, modelLabel: item.model, deps: input.deps });
    if (ok) started += 1; else failed.push(item);
  }));
  if (started > 0) input.deps.toast({ type: "success", title: `Started ${started} ${started === 1 ? "thread" : "threads"} in background` });
  if (failed.length === 0) input.releaseAttachments();
  else { setFanoutSelections(input.draftId, failed); input.restoreDraft(); }
  return started;
}

/** resolveMultipleModelTargets (chatViewSend.ts): the first selected model that cannot take the message, as the thread error. */
export function multipleModelTargetError(selections: FanoutSelection[], statuses: readonly ProviderStatus[]): string | null {
  for (const item of selections) {
    const status = statuses.find((entry) => entry.instanceId === item.provider);
    if (!status?.enabled || !status.available || status.status !== "ready") return `Provider for ${item.model} is unavailable.`;
    const blocked = antigravitySendBlockReason(status, item.model);
    if (blocked) return blocked;
  }
  return null;
}
