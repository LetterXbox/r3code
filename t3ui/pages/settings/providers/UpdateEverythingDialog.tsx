// UpdateEverythingDialog.tsx (providers only): a confirmation modal listing what will update, which then
// shows each provider's progress and the result. Registered with the WebView occlusion registry while open;
// Escape and the backdrop close it unless an update is running.
import { MiddleTruncate } from "../../../components/MiddleTruncate";
import { Text, View } from "nsh";
import { SettingsDialog } from "../../../components/SettingsDialog";
import { useOverlayOpen } from "../../../components/rightPanel/nativeOcclusion";
import { PROVIDER_RUN_STATUS_LABELS, updateEverythingDescription, updateEverythingProgress, updateEverythingSummary, updateEverythingTitle, type UpdateEverythingMachine } from "./updateEverything";
import { ButtonText, PillButton, UiIcon } from "./ui";

export function UpdateEverythingDialog(props: {
  machines: UpdateEverythingMachine[];
  phase: "confirm" | "running" | "done";
  onConfirm: () => void;
  onClose: () => void;
  title?: string; confirmLabel?: string; notes?: string[]; disabledReason?: string | null; checking?: boolean;
}) {
  useOverlayOpen(true, "update everything");
  const providerCount = () => props.machines.reduce((count, machine) => count + machine.providers.length, 0);
  const updating = () => props.machines.filter((machine) => machine.providers.length > 0);
  const skipped = () => props.machines.filter((machine) => machine.skipped !== null);
  const summary = () => props.phase === "done" ? updateEverythingSummary(props.machines) : null;
  const running = () => props.phase === "running";
  const title = () => props.phase === "running" ? "Updating providers" : props.phase === "done" ? summary()?.title ?? "Nothing to update" : props.title ?? updateEverythingTitle(props.machines);
  const description = () => props.phase === "running" ? updateEverythingProgress(props.machines) : props.phase === "done" ? undefined : updateEverythingDescription(providerCount(), props.checking === true) || undefined;
  return <SettingsDialog open onClose={() => { if (!running()) props.onClose(); }} title={title()} description={description()} width={576} testID="Update everything dialog"
    footer={<>
      {props.disabledReason ? <Text class="mr-auto self-center text-sm text-foreground">{props.disabledReason}</Text> : null}
      {props.phase === "done" ? <PillButton label="Close update dialog" variant="primary" onPress={props.onClose}><ButtonText tone="primary">Done</ButtonText></PillButton> : <>
        <PillButton label="Cancel update" disabled={running()} onPress={props.onClose}><ButtonText>Cancel</ButtonText></PillButton>
        <PillButton label={props.confirmLabel ?? "Update"} variant="primary" disabled={running() || (props.disabledReason ?? null) !== null || providerCount() === 0} onPress={props.onConfirm}><ButtonText tone="primary">{props.confirmLabel ?? "Update"}</ButtonText></PillButton>
      </>}
    </>}>
    <View class="gap-3">
      {(props.notes ?? []).map((note) => <Text class="text-sm text-muted-foreground">{note}</Text>)}
      {props.phase === "done" && summary()?.description ? <Each of={(summary()?.description ?? "").split("\n")} key={(line, index) => `${index}:${line}`}>{(line) => <Text class="text-sm text-destructive-foreground">{line()}</Text>}</Each> : null}
      <View class="border-b border-border-60 pb-1.5 flex-row gap-4">
        <Text class="w-40 text-xs text-muted-foreground">Machine</Text>
        <Text class="min-w-0 flex-1 text-xs text-muted-foreground">Providers</Text>
      </View>
      <Each of={updating()} key={(machine) => machine.key}>{(machine) => <View class="flex-row gap-4 border-b border-border-50 py-1.5" testID={`Update machine ${machine().label}`}>
        <MiddleTruncate value={machine().label} class="w-40" textClass="text-sm text-foreground" />
        <View class="min-w-0 flex-1 gap-1">
          <Each of={machine().providers} key={(provider) => provider.instanceId}>{(provider) => <View class="flex-row items-center justify-between gap-2">
            <Text class="text-sm text-foreground">{provider().name}</Text>
            {props.phase === "confirm" ? null : <View class="flex-row items-center gap-1">
              {provider().status === "updating" ? <UiIcon name="loader-circle" size={12} /> : provider().status === "done" ? <UiIcon name="check" size={12} /> : provider().status === "failed" ? <UiIcon name="triangle-alert" size={12} tone="warning" /> : null}
              <Text class={provider().status === "failed" ? "text-xs text-warning" : "text-xs text-muted-foreground"}>{PROVIDER_RUN_STATUS_LABELS[provider().status]}</Text>
            </View>}
          </View>}</Each>
        </View>
      </View>}</Each>
      {skipped().length > 0 ? <View class="gap-1">
        <Text class="text-xs text-muted-foreground">{`${skipped().length} skipped`}</Text>
        <Each of={skipped()} key={(machine) => machine.key}>{(machine) => <View class="flex-row gap-3 pl-4"><Text class="w-32 truncate text-xs text-muted-foreground">{machine().label}</Text><Text class="min-w-0 flex-1 text-xs text-muted-foreground">{machine().skipped}</Text></View>}</Each>
      </View> : null}
    </View>
  </SettingsDialog>;
}
