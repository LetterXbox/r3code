// thread.visit: moves the server's read watermark so a finished run stops showing "Done".
// The web does this in ThreadVisitWatermark; the sidebar owns the watermark's only reader
// here, so it also owns the write. `opened` is true when the thread was just opened, not when
// activity landed on one that was already open.
import { effect } from "nsh";
import { backendStatus, isServerThread, openThread } from "../../store";
import { visitThread } from "./threadActions";

let lastKey = "";
let lastThread = "";

let started = false;

export function startThreadVisits(): void {
  if (started) return;
  started = true;
  effect(() => {
    const thread = openThread();
    if (!thread || backendStatus() !== "connected" || !isServerThread(thread.id)) return;
    const key = `${thread.id}:${thread.meta?.latestRunCompletedAt ?? 0}`;
    if (key === lastKey) return;
    lastKey = key;
    const opened = thread.id !== lastThread;
    lastThread = thread.id;
    void visitThread(thread.id, opened).catch(() => {});
  });
}
