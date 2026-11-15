// useApplyThreadModelPick: an existing thread's composer pick (a model of its own provider instance, or a change of
// that model's options such as effort) is set on the thread at once, so any next turn runs on it.
import { liveThreadProjection, modelOptionsFor } from "../../store";
import { showToast } from "../toast/toastState";
import { shouldApplyThreadModelPick } from "./pickerModel";
import { setThreadModelSelection } from "./runCommands";

export function applyThreadModelPick(threadId: string | undefined, instanceId: string, model: string): void {
  if (!threadId) return;
  if (!shouldApplyThreadModelPick({ projection: liveThreadProjection(threadId), instanceId })) return;
  const options = modelOptionsFor(instanceId, model);
  void setThreadModelSelection(threadId, { instanceId, model, ...(options ? { options } : {}) }).catch((error: unknown) => showToast({
    type: "error", title: "Could not apply model selection", threadRef: { threadId },
    description: `This model pick was not saved. ${error instanceof Error ? error.message : "Try again."}`,
  }));
}
