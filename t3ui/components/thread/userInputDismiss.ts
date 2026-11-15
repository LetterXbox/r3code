// "Dismiss question without answering": the thread.user-input.dismiss command (contracts orchestrationV2).
import { openThread, requestBackend, threadScopeOverride } from "../../store";

export async function dismissUserInput(requestId: string): Promise<void> {
  const threadId = threadScopeOverride() ?? openThread()?.id;
  if (!threadId) throw new Error("This question is no longer available");
  await requestBackend("orchestration.dispatchCommand", {
    type: "thread.user-input.dismiss",
    commandId: `command:${crypto.randomUUID()}`,
    threadId,
    requestId,
  });
}
