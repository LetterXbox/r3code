// The reference's Working exit grace (createInboxReturnTracker in client-runtime threadInbox.ts): a thread
// that stopped working keeps its Working place for 2s, because an orchestrator run can end moments before its
// continuation starts. Only placement is held; attention requests and settling stay authoritative.
import type { Thread } from "../../store";
import { isThreadWorking } from "./threadStatus";

export const WORKING_EXIT_GRACE_MS = 2_000;

interface State { working: boolean; deadline: number | null; placement: string | null }

/** Attention that must show at once: a pending request, a plan to act on, a failure. */
function actionable(thread: Thread): boolean {
  const meta = thread.meta;
  return thread.status === "awaiting" || thread.status === "stopped" && Boolean(thread.error) ||
    (meta !== undefined && (meta.pendingRequestKind !== null || meta.pendingSubagentRequest === true || meta.pendingGuestMessageCount > 0 ||
      (meta.interactionMode === "plan" && meta.hasActionableProposedPlan) || meta.lastErrorClass !== null || meta.runStatus === "failed"));
}

/** The fields that place a row in a section; a change in them ends the hold (the row moved on purpose). */
function placementOf(thread: Thread): string {
  const meta = thread.meta;
  return JSON.stringify([thread.pinned, meta?.settled ?? false, meta?.snoozedUntil ?? null, meta?.activeOrderKey ?? null]);
}

export function createWorkingGrace() {
  const states = new Map<string, State>();
  const returns = new Map<string, number>();
  return {
    /** The reference forgets observed returns while the Working shelf is disabled. */
    clear(): boolean {
      const changed = states.size > 0 || returns.size > 0;
      states.clear();
      returns.clear();
      return changed;
    },
    /** Records the current threads; `at` is wall-clock ms. */
    observe(threads: readonly Thread[], at: number) {
      let changed = false;
      const present = new Set<string>();
      for (const thread of threads) {
        present.add(thread.id);
        const previous = states.get(thread.id);
        const actual = isThreadWorking(thread);
        const placement = actual || previous?.working ? placementOf(thread) : null;
        const moved = previous !== undefined && previous.placement !== placement;
        const excluded = thread.pinned || thread.meta?.settled === true || (thread.meta?.snoozedUntil ?? 0) > at;
        const deadline = !actual && previous?.working && !actionable(thread) && !moved && !excluded
          ? (previous.deadline ?? at + WORKING_EXIT_GRACE_MS) : null;
        const working = actual || (deadline !== null && deadline > at);
        if ((previous?.working ?? false) !== working) changed = true;
        if (previous?.working && !working) returns.set(thread.id, at);
        states.set(thread.id, { working, deadline: working ? deadline : null, placement });
      }
      for (const id of [...states.keys()]) {
        if (!present.has(id)) { if (states.get(id)?.working) changed = true; states.delete(id); returns.delete(id); }
      }
      return changed;
    },
    /** Ends every held place whose deadline has passed; true when any ended. */
    expire(at: number): boolean {
      let changed = false;
      for (const [id, state] of states) {
        if (state.deadline !== null && state.deadline <= at) {
          state.working = false;
          state.deadline = null;
          returns.set(id, at);
          changed = true;
        }
      }
      return changed;
    },
    /** The soonest deadline still pending, or null. */
    nextDeadline(): number | null {
      let next: number | null = null;
      for (const state of states.values()) {
        if (state.deadline !== null && (next === null || state.deadline < next)) next = state.deadline;
      }
      return next;
    },
    isWorking: (thread: Thread): boolean => states.get(thread.id)?.working ?? isThreadWorking(thread),
    returnedAt: (thread: Thread): number | undefined => returns.get(thread.id),
  };
}
