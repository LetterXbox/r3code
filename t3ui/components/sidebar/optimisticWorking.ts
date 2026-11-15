// The moment a message is sent the thread reads Working, before the server's shell reports the run. The
// store lists the ids whose dispatch is in flight; this overlays them on the sidebar's threads.
import { sendingThreadIdList } from "../../store";
import type { Thread } from "../../store";
import { isThreadWorking } from "./threadStatus";

const since = new Map<string, number>();

/** The same threads, each one mid-send shown as a Working run that began when the send did. */
export function withOptimisticWorking(threads: readonly Thread[], now = Date.now(), sending: readonly string[] = sendingThreadIdList()): Thread[] {
  for (const id of [...since.keys()]) if (!sending.includes(id)) since.delete(id);
  if (sending.length === 0) return [...threads];
  return threads.map((thread) => {
    if (!sending.includes(thread.id)) return thread;
    const meta = thread.meta;
    if (meta && (meta.pendingRequestKind !== null || meta.pendingSubagentRequest === true)) return thread;
    if (isThreadWorking(thread) && (meta?.runtimeStatus === "running" || thread.status === "running")) return thread;
    const started = since.get(thread.id) ?? now;
    since.set(thread.id, started);
    return {
      ...thread,
      status: "running",
      updatedAt: started,
      ...(meta ? { meta: { ...meta, runStatus: "running", activityRunStatus: "running", runtimeStatus: "running", activityStartedAt: started } } : {}),
    };
  });
}
