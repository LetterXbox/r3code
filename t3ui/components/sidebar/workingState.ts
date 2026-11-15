// The live Working-shelf state: the exit-grace tracker fed by the store's threads, and a version signal the
// sections read so a held place ends on its deadline.
import { effect, signal, untracked } from "nsh";
import { allThreads, generalSettings, settingValue } from "../../store";
import type { Thread } from "../../store";
import { createWorkingGrace } from "./workingGrace";
import { withOptimisticWorking } from "./optimisticWorking";
import { listedWithSubagentRequests } from "./subagentRequests";

const grace = createWorkingGrace();
const version = signal(0);
let timer: ReturnType<typeof setTimeout> | undefined;

function schedule() {
  clearTimeout(timer);
  timer = undefined;
  const next = grace.nextDeadline();
  if (next === null) return;
  timer = setTimeout(() => {
    grace.expire(Date.now());
    version.update((value) => value + 1);
    schedule();
  }, Math.max(0, next - Date.now()));
}

/** Observes every thread whenever the store's threads change. Call once from the sidebar. */
export function startWorkingGrace() {
  effect(() => {
    const threads = withOptimisticWorking(listedWithSubagentRequests(allThreads()));
    const enabled = generalSettings().sidebarWorkingShelfEnabled && settingValue("boringSidebarEnabled") !== true;
    untracked(() => {
      const changed = enabled ? grace.observe(threads, Date.now()) : grace.clear();
      schedule();
      if (changed) version.update((value) => value + 1);
    });
  });
}

/** Whether the thread holds a Working place: running now, or inside its 2s exit grace. */
export function holdsWorkingPlace(thread: Thread): boolean {
  version();
  return grace.isWorking(thread);
}

/** A thread returning from Working joins the inbox at the observed return time. */
export function workingReturnAt(thread: Thread): number | undefined {
  version();
  return grace.returnedAt(thread);
}
