// SidebarUpdatePill.tsx's "everything" entry (runsEverything): when the connected environment has providers that can update in
// place, the footer shows the round update button (bg-sidebar-control-surface, size-8 rounded-full) with the plan's summary as its
// tooltip ("Update 2 providers"); a press opens UpdateEverythingDialog (pages/settings/providers/UpdateEverythingDialog.tsx), whose
// Update runs every provider update at once (server.updateProvider) and shows progress, then the result.
//
// Provider-only by design: the reference's plan also lists this app's update (no updater here) and server updates of other machines
// (the port updates a machine's server from its environment row), so the countdown capsule (SidebarUpdateCapsule) has nothing to show.
import { computed, signal, View } from "nsh";
import { backendStatus, rawProviderRecords, refreshProviderStatuses } from "../../store";
import { showToast } from "../toast/toastState";
import { liveProviderApi } from "../../pages/settings/providers/data";
import { DRIVERS } from "../../pages/settings/providers/driverMeta";
import { parseProvider, updateCandidates, type ProviderView } from "../../pages/settings/providers/logic";
import { UpdateEverythingDialog } from "../../pages/settings/providers/UpdateEverythingDialog";
import { updateEverythingSummary, type UpdateEverythingMachine, type UpdateEverythingProviderRun } from "../../pages/settings/providers/updateEverything";
import { Glyph } from "./SidebarGlyph";
import { SidebarUpdateCapsule } from "./SidebarUpdateCapsule";
import { runFinishedCleanly, type UpdateEverythingRun } from "./updateCapsule";
import { Tip } from "./Tip";

const nameOfDriver = (driver: string) => DRIVERS.find((meta) => meta.driver === driver)?.label ?? driver;

/** describeUpdateEverything's summary for a provider-only plan. */
export function updateEverythingSummaryLabel(providerCount: number): string {
  return `Update ${providerCount} provider${providerCount === 1 ? "" : "s"}`;
}

/** The plan's one machine: the connected environment and its update candidates. */
export function planMachine(label: string, candidates: readonly ProviderView[]): UpdateEverythingMachine {
  return {
    key: "local",
    label,
    skipped: null,
    providers: candidates.map((provider): UpdateEverythingProviderRun => ({ instanceId: provider.instanceId, driver: provider.driver, name: provider.displayName ?? nameOfDriver(provider.driver), status: "waiting", failure: null })),
  };
}

/** Runs every provider of `machine` at once, reporting each status change. */
export async function runProviderUpdates(
  machine: UpdateEverythingMachine,
  update: (input: { driver: string; instanceId: string }) => Promise<{ status?: string; message?: string | null } | null>,
  onChange: (next: UpdateEverythingMachine) => void,
): Promise<UpdateEverythingMachine> {
  let current = machine;
  const set = (instanceId: string, change: Partial<UpdateEverythingProviderRun>) => {
    current = { ...current, providers: current.providers.map((run) => (run.instanceId === instanceId ? { ...run, ...change } : run)) };
    onChange(current);
  };
  await Promise.all(machine.providers.map(async (run) => {
    set(run.instanceId, { status: "updating" });
    try {
      const state = await update({ driver: run.driver, instanceId: run.instanceId });
      if (state?.status === "succeeded") set(run.instanceId, { status: "done", failure: null });
      else set(run.instanceId, { status: "failed", failure: state?.message ?? "Provider update did not finish." });
    } catch (cause) {
      set(run.instanceId, { status: "failed", failure: cause instanceof Error && cause.message ? cause.message : "The provider update command could not be started." });
    }
  }));
  return current;
}

const candidates = computed(() => backendStatus() === "connected" ? updateCandidates(rawProviderRecords().map(parseProvider).filter((p): p is ProviderView => p !== null)) : []);
const dialog = signal<{ machines: UpdateEverythingMachine[]; checking: boolean } | null>(null);
/** useUpdateEverythingRun: the run in progress, or one that ended with a failure and waits to be dismissed. */
const run = signal<UpdateEverythingRun | null>(null);
const now = signal(Date.now());

/** runsEverything: the footer's update button is this one instead of the idle check (SidebarUpdateButton). */
export const showsUpdateEverything = () => candidates().length > 0 || run() !== null;

/** handleAction + runEverything: the dialog closes on Update and the run continues in the capsule; the result is a toast. */
export async function startUpdateEverything(machine: UpdateEverythingMachine, update: Parameters<typeof runProviderUpdates>[1]): Promise<void> {
  now.set(Date.now());
  run.set({ machine, startedAt: Date.now() });
  // The capsule's elapsed time ticks every 30 s while a provider is still updating (SidebarUpdateCapsule's useNow).
  const ticker = setInterval(() => now.set(Date.now()), 30_000);
  const finished = await runProviderUpdates(machine, update, (next) => run.update((current) => (current ? { ...current, machine: next } : current))).finally(() => clearInterval(ticker));
  const summary = updateEverythingSummary([finished]);
  if (summary) showToast({ type: summary.type, title: summary.title, ...(summary.description ? { description: summary.description } : {}) });
  const settled = { machine: finished, startedAt: run()?.startedAt ?? Date.now() };
  run.set(runFinishedCleanly(settled) ? null : settled);
}

export function SidebarUpdateEverythingButton() {
  const open = () => {
    if (run() !== null) return;
    dialog.set({ machines: [planMachine(liveProviderApi.environmentLabel(), candidates())], checking: true });
    // Machines that still cache an older latest version add their rows while the dialog is open.
    void refreshProviderStatuses({ fresh: true }).catch(() => undefined).finally(() => {
      const current = dialog();
      if (current) dialog.set({ machines: [planMachine(liveProviderApi.environmentLabel(), candidates())], checking: false });
    });
  };
  const confirm = () => {
    const plan = dialog();
    if (!plan) return;
    dialog.set(null);
    void startUpdateEverything(plan.machines[0]!, (input) => liveProviderApi.updateProvider(input));
  };
  return (
    <>
      {run() !== null ? (
        <SidebarUpdateCapsule run={run()!} now={() => now()} onDismiss={() => run.set(null)} />
      ) : showsUpdateEverything() ? (
        <View
          accessibilityLabel={updateEverythingSummaryLabel(candidates().length)}
          role="button"
          tooltip={<Tip label={updateEverythingSummaryLabel(candidates().length)} />}
          class="ml-auto size-8 items-center justify-center rounded-full bg-sidebar-control-surface hover:bg-sidebar-row-hover"
          onPress={open}
          testID="Sidebar update everything"
        >
          <Glyph name="circle-arrow-up" size={16} />
        </View>
      ) : null}
      {dialog() ? (
        <UpdateEverythingDialog
          machines={dialog()!.machines}
          phase="confirm"
          checking={dialog()!.checking}
          onConfirm={confirm}
          onClose={() => dialog.set(null)}
        />
      ) : null}
    </>
  );
}
