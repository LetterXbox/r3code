// updateEverything.logic.ts describeUpdateCapsule / RUN_STATUS_LABELS / formatUpdateElapsed / closeFinishedUpdateRun, for the
// provider-only run the footer button starts (SidebarUpdateEverythingButton.tsx). The reference's machines are environments; the
// port has one, whose status is "updating providers" until every provider settled, then done or failed. There is no server
// update to retry, so a failed run offers Dismiss only (the reference's retry needs `machine.server`).
import { PROVIDER_RUN_STATUS_LABELS, type UpdateEverythingMachine } from "../../pages/settings/providers/updateEverything";

export type UpdateRunMachineStatus = "providers" | "done" | "failed";
export interface UpdateEverythingRun { machine: UpdateEverythingMachine; startedAt: number }
export interface UpdateCapsuleView { tone: "default" | "slow" | "failed"; label: string; slow?: { status: string; elapsed: string }; action: "dismiss" | null }

export const UPDATE_SLOW_AFTER_MS = 3 * 60 * 1000;

/** RUN_STATUS_LABELS for the statuses a provider-only run reaches. */
export const RUN_STATUS_LABELS: Record<UpdateRunMachineStatus, string> = { providers: PROVIDER_RUN_STATUS_LABELS.updating, done: "done", failed: "failed" };

export function formatUpdateElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function runMachineStatus(machine: UpdateEverythingMachine): UpdateRunMachineStatus {
  if (machine.providers.some((provider) => provider.status === "waiting" || provider.status === "updating")) return "providers";
  return machine.providers.some((provider) => provider.status === "failed") ? "failed" : "done";
}

/** The machine's failure text under its row in the popup: each failed provider's line. */
export function runMachineFailure(machine: UpdateEverythingMachine): string | null {
  const lines = machine.providers.filter((provider) => provider.status === "failed").map((provider) => `${provider.name}: ${provider.failure ?? "Provider update did not finish."}`);
  return lines.length === 0 ? null : lines.join("\n");
}

export function describeUpdateCapsule(run: UpdateEverythingRun, now: number): UpdateCapsuleView {
  const status = runMachineStatus(run.machine);
  const elapsed = now - run.startedAt;
  if (status === "providers" && elapsed >= UPDATE_SLOW_AFTER_MS) {
    return { tone: "slow", label: run.machine.label, slow: { status: RUN_STATUS_LABELS[status], elapsed: formatUpdateElapsed(elapsed) }, action: null };
  }
  if (status === "providers") return { tone: "default", label: "0 of 1 updated", action: null };
  if (status === "failed") return { tone: "failed", label: `${run.machine.label} failed`, action: "dismiss" };
  return { tone: "default", label: "1 of 1 updated", action: null };
}

/** closeFinishedUpdateRun: a run whose machine updated without failure closes; a failed one stays until dismissed. */
export const runFinishedCleanly = (run: UpdateEverythingRun): boolean => runMachineStatus(run.machine) === "done";
