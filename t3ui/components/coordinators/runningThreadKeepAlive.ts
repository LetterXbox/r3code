// RunningThreadKeepAlive (apps/web/src/components/desktop/RunningThreadKeepAlive.tsx, state/threads.ts
// runningThreadKeepAliveAtom): every running thread keeps its thread subscription while it runs, so its detail is
// live when opened and its completion is seen. The open thread already has its own subscription.
import { effect, untracked } from "nsh";
import { allThreads, openThread, retainThread } from "../../store";

const kept = new Map<string, () => void>();

/** Retains exactly the running threads other than `openId`; returns the kept ids. */
export function syncRunningThreadKeepAlive(running: readonly string[], openId: string | null): string[] {
  const wanted = new Set(running.filter((id) => id !== openId));
  for (const [id, release] of kept) if (!wanted.has(id)) { release(); kept.delete(id); }
  for (const id of wanted) if (!kept.has(id)) kept.set(id, retainThread(id));
  return [...kept.keys()];
}

let installed = false;
export function installRunningThreadKeepAlive() {
  if (installed) return;
  installed = true;
  effect(() => {
    const running = allThreads().filter((thread) => thread.status === "running").map((thread) => thread.id);
    const openId = openThread()?.id ?? null;
    untracked(() => syncRunningThreadKeepAlive(running, openId));
  });
}
