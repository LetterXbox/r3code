// RelayClientInstallDialog and its state (apps/web/src/cloud/relayClientInstallDialog.ts,
// components/cloud/RelayClientInstallDialog.tsx). The reference raises it from T3 Connect linking
// (cloud/linkEnvironment.ts); the port has no T3 Connect flow yet, so nothing calls the request today.
import { signal, Text, View } from "nsh";
import { SettingsDialog } from "../components/SettingsDialog";
import { SettingsButton } from "../components/SettingsLayout";

export type RelayClientInstallStage = "checking" | "waiting_for_lock" | "downloading" | "verifying" | "installing" | "validating" | "activating";
type View_ = { status: "confirming"; version: string } | { status: "installing"; version: string; stage: RelayClientInstallStage };
export type RelayClientInstallDialogState = { status: "idle" } | View_ | { status: "closing"; view: View_ };

export const INSTALL_STEPS: { stage: RelayClientInstallStage; label: string }[] = [
  { stage: "checking", label: "Checking current installation" },
  { stage: "waiting_for_lock", label: "Waiting for installer" },
  { stage: "downloading", label: "Downloading relay client" },
  { stage: "verifying", label: "Verifying download" },
  { stage: "installing", label: "Installing relay client" },
  { stage: "validating", label: "Validating executable" },
  { stage: "activating", label: "Activating installation" },
];

const state = signal<RelayClientInstallDialogState>({ status: "idle" });
let resolveConfirmation: ((confirmed: boolean) => void) | null = null;
export const relayClientInstallDialogState = () => state();

export function requestRelayClientInstallConfirmation(version: string): Promise<boolean> {
  const current = state();
  if (current.status !== "idle") {
    const active = current.status === "closing" ? current.view : current;
    return Promise.reject(new Error(`Cannot confirm relay client installation ${version}; installation ${active.version} has dialog status ${current.status}.`));
  }
  state.set({ status: "confirming", version });
  return new Promise<boolean>((resolve) => { resolveConfirmation = resolve; });
}

export function respondToRelayClientInstallConfirmation(confirmed: boolean) {
  const current = state();
  if (current.status !== "confirming" || !resolveConfirmation) return;
  const resolve = resolveConfirmation;
  resolveConfirmation = null;
  state.set(confirmed ? { status: "installing", version: current.version, stage: "checking" } : { status: "closing", view: current });
  resolve(confirmed);
}

export function reportRelayClientInstallProgress(event: { type: string; stage?: RelayClientInstallStage }) {
  const current = state();
  if (current.status !== "installing" || event.type !== "progress" || !event.stage) return;
  state.set({ ...current, stage: event.stage });
}

export function finishRelayClientInstall() {
  resolveConfirmation?.(false);
  resolveConfirmation = null;
  const current = state();
  if (current.status === "confirming" || current.status === "installing") state.set({ status: "closing", view: current });
}

export function completeRelayClientInstallDialogClose() {
  if (state().status === "closing") state.set({ status: "idle" });
}

export function RelayClientInstallDialogHost() {
  return () => {
    const current = state();
    if (current.status === "idle") return null;
    const view = current.status === "closing" ? current.view : current;
    // No exit animation here: the closing state ends at once.
    if (current.status === "closing") { queueMicrotask(completeRelayClientInstallDialogClose); return null; }
    const installing = view.status === "installing";
    const index = installing ? INSTALL_STEPS.findIndex((step) => step.stage === view.stage) : -1;
    return (
      <SettingsDialog
        open
        width={448}
        onClose={() => { if (view.status === "confirming") respondToRelayClientInstallConfirmation(false); }}
        title={installing ? "Installing relay client" : "Install relay client?"}
        description={installing ? "R3 Code is preparing this environment for secure access through T3 Connect." : "R3 Code needs the relay client to make this environment available through T3 Connect."}
        footer={view.status === "confirming" ? <>
          <SettingsButton label="Cancel" onPress={() => respondToRelayClientInstallConfirmation(false)} />
          <SettingsButton tone="primary" label="Download and install" onPress={() => respondToRelayClientInstallConfirmation(true)} />
        </> : undefined}
      >
        {installing ? (
          <View class="gap-2.5">
            <View class="flex-row items-center justify-between gap-3">
              <Text class="text-sm font-medium text-foreground">{INSTALL_STEPS[index]?.label ?? ""}</Text>
              <Text class="text-sm text-muted-foreground">{`${index + 1} of ${INSTALL_STEPS.length}`}</Text>
            </View>
            <View class="h-2 w-full overflow-hidden rounded-full bg-muted" accessibilityLabel="Relay client installation progress">
              <View class="h-2 rounded-full bg-primary" style={{ width: `${((index + 1) / INSTALL_STEPS.length) * 100}%` }} />
            </View>
            <Text class="text-xs text-muted-foreground">Keep R3 Code open while the relay client is installed.</Text>
          </View>
        ) : (
          <View class="rounded-xl border border-border p-3">
            <Text class="text-sm font-medium text-foreground">Managed relay client</Text>
            <Text class="mt-1 text-sm text-muted-foreground">{`R3 Code will download and install version ${view.version} locally.`}</Text>
          </View>
        )}
      </SettingsDialog>
    );
  };
}
