// The provider half of sidebar/updateEverything.logic.ts: the confirmation rows, the per-provider run
// status labels and the result summary the web shows once every update settles.
export type ProviderRunStatus = "waiting" | "updating" | "done" | "failed";
export interface UpdateEverythingProviderRun { instanceId: string; driver: string; name: string; status: ProviderRunStatus; failure: string | null }
export interface UpdateEverythingMachine { key: string; label: string; providers: UpdateEverythingProviderRun[]; skipped: string | null }

/** RUN_STATUS_LABELS, for the statuses a provider-only run reaches. */
export const PROVIDER_RUN_STATUS_LABELS: Record<ProviderRunStatus, string> = { waiting: "waiting", updating: "updating providers", done: "done", failed: "failed" };

function countLabel(count: number, noun: string): string | null { return count === 0 ? null : `${count} ${noun}${count === 1 ? "" : "s"}`; }
function joinList(parts: readonly string[]): string {
  if (parts.length <= 2) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

/** The dialog's title when the caller gives none: machines that have something to update. */
export function updateEverythingTitle(machines: readonly UpdateEverythingMachine[]): string {
  const updating = machines.filter((machine) => machine.providers.length > 0).length;
  return `Update ${updating} ${updating === 1 ? "machine" : "machines"}?`;
}

/** The dialog's description: "N provider updates" with an optional "Checking for more…" tail. */
export function updateEverythingDescription(providerCount: number, checking: boolean): string {
  const parts = [countLabel(providerCount, "provider update")].filter((part): part is string => part !== null);
  if (checking) parts.push("Checking for more…");
  return parts.join(" · ");
}

/** getUpdateEverythingToastView for a provider-only run; null when nothing finished. */
export function updateEverythingSummary(machines: readonly UpdateEverythingMachine[]): { type: "success" | "error"; title: string; description?: string } | null {
  const runs = machines.flatMap((machine) => machine.providers.map((provider) => ({ machine: machine.label, provider })));
  const updated = runs.filter((run) => run.provider.status === "done").length;
  const failures = runs.filter((run) => run.provider.status === "failed").map((run) => `${run.machine} · ${run.provider.name}: ${run.provider.failure ?? "Provider update did not finish."}`);
  const parts = [countLabel(updated, "provider")].filter((part): part is string => part !== null);
  if (failures.length === 0) return parts.length === 0 ? null : { type: "success", title: `Updated ${joinList(parts)}` };
  return { type: "error", title: parts.length === 0 ? "Update failed" : `Updated ${joinList(parts)}`, description: failures.join("\n") };
}

/** "2 of 3 updated": the capsule's default label while providers are still running. */
export function updateEverythingProgress(machines: readonly UpdateEverythingMachine[]): string {
  const runs = machines.flatMap((machine) => machine.providers);
  return `${runs.filter((run) => run.status === "done").length} of ${runs.length} updated`;
}
