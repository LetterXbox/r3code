// BackgroundActivitySettings.tsx and IntervalSecondsField.tsx: the Background activity row (a profile select, and
// for Advanced a gear that opens the interval dialog) and the dialog itself: the shared policy, four intervals in
// seconds and four pause switches. Only one environment can be tuned that finely, as in the web.
import { signal, Text, View } from "nsh";
import { DialogInput as Input } from "../../components/DialogInput";
import { SettingsButton, SettingsSelect, SettingsSwitch } from "../../components/SettingsLayout";
import { SettingsDialog } from "../../components/SettingsDialog";
import { SettingsIcon } from "./SettingsIcon";
import { createStepperKeys } from "../../components/stepperKeys";
import { writeScopedPatch } from "./scopeState";
import { serverSettings } from "./settingsState";
import {
  BOOLEAN_OVERRIDES, PROFILE_LABELS, PROVIDER_HEALTH_INTERVAL_STEP_SECONDS, overridePatch, profileOption, profilePatch, resetPatch, resolveBackgroundActivity, sharedPolicyPatch,
  type Profile,
} from "./backgroundActivity";

type Dict = Record<string, unknown>;
const settings = () => serverSettings() as Dict | null;
const dialogOpen = signal(false);

/** normalizeIntervalSeconds: a whole number of seconds, no lower than the field's minimum. */
export const normalizeIntervalSeconds = (value: number, min: number) => Math.max(min, Math.round(value));

/** The seconds stepper: `-`, the number, `+`; a draft commits on Enter or blur and falls back when it is not a number. */
export function IntervalSecondsField(props: { label: string; value: number; min: number; step: number; onCommit: (seconds: number) => void }) {
  const draft = signal<string | null>(null);
  const shown = () => draft() ?? String(props.value);
  const commit = (next: number) => {
    draft.set(null);
    const seconds = normalizeIntervalSeconds(next, props.min);
    if (seconds !== props.value) props.onCommit(seconds);
  };
  const submit = () => { const parsed = Number(draft() ?? props.value); if (Number.isFinite(parsed)) commit(parsed); else draft.set(null); };
  // NumberField min `min`, step `step`: the arrows step from the typed draft when it is a number.
  const keys = createStepperKeys(() => { const typed = Number(draft() ?? props.value); return Number.isFinite(typed) ? typed : props.value; }, commit, () => ({ min: props.min, step: props.step }));
  const stepper = "size-7 items-center justify-center rounded-md hover:bg-accent transition-all duration-150 ease-in-out active:scale-[0.97]";
  return (
    <View class="h-7 w-32 flex-row items-center rounded-lg border border-input bg-background" testID={`${props.label} = ${props.value}`}>
      <View role="button" accessibilityLabel={`Decrease ${props.label}`} class={stepper} onPress={() => commit(props.value - props.step)}><SettingsIcon name="minus" size={14} /></View>
      <Input value={shown()} accessibilityLabel={`${props.label.charAt(0).toUpperCase()}${props.label.slice(1)} in seconds`} onChange={(e: { value: string }) => draft.set(e.value)} onSubmit={submit} onFocus={keys.onFocus} onBlur={() => { keys.onBlur(); submit(); }} class="h-7 min-w-0 flex-1 px-1 text-center text-sm text-foreground" />
      <View role="button" accessibilityLabel={`Increase ${props.label}`} class={stepper} onPress={() => commit(props.value + props.step)}><SettingsIcon name="plus" size={14} /></View>
    </View>
  );
}

const resolved = () => resolveBackgroundActivity(settings());
const seconds = (ms: number) => Math.round(ms / 1000);

function DialogRow(props: { title: string; description: string; children: any; first?: boolean }) {
  return (
    <View class={`flex-row items-center justify-between gap-3 px-4 py-3 ${props.first ? "" : "border-t border-border"}`}>
      <View class="min-w-0 flex-1 gap-1">
        <Text class="text-sm font-medium text-foreground">{props.title}</Text>
        <Text class="text-xs leading-relaxed text-muted-foreground">{props.description}</Text>
      </View>
      <View class="shrink-0 flex-row items-center gap-2">{props.children}</View>
    </View>
  );
}

function Interval(props: { label: string; field: "automaticGitFetchInterval" | "providerHealthRefreshInterval" | "hostPowerMonitorActiveInterval" | "hostPowerMonitorIdleInterval"; min: number; step: number }) {
  return (
    <>
      <IntervalSecondsField label={props.label} value={seconds(resolved()[props.field])} min={props.min} step={props.step} onCommit={(value) => void writeScopedPatch(overridePatch(settings(), { [props.field]: value * 1000 }))} />
      <Text class="text-xs text-muted-foreground">seconds</Text>
    </>
  );
}

function AdvancedDialog() {
  return (
    <SettingsDialog
      open={dialogOpen()}
      onClose={() => dialogOpen.set(false)}
      title="Background Activity"
      description="Tune the shared power policy and the background intervals that feed it."
      width={576}
      testID="Background activity dialog"
      footer={<><SettingsButton label="Reset all" onPress={() => void writeScopedPatch(resetPatch())} /><SettingsButton label="Done" tone="primary" onPress={() => dialogOpen.set(false)} /></>}
    >
      <View class="overflow-hidden rounded-xl border border-border bg-card">
        <DialogRow first title="Shared policy" description="Controls whether background work may run after a subscribed interval fires.">
          <SettingsSelect inline
            label="Shared background policy"
            value={resolved().profile}
            compactWidth={160}
            options={(["balanced", "performance", "battery-saver"] as Profile[]).map((profile) => ({ value: profile, label: PROFILE_LABELS[profile] }))}
            onChange={(next) => void writeScopedPatch(sharedPolicyPatch(settings(), next as Profile))}
          />
        </DialogRow>
        <DialogRow title="Git fetch interval" description="Refresh remote branch status in the background."><Interval label="Git fetch interval" field="automaticGitFetchInterval" min={0} step={5} /></DialogRow>
        <DialogRow title="Provider health interval" description="Refresh provider availability, versions, and auth state. Model catalog updates follow Provider update checks."><Interval label="provider health interval" field="providerHealthRefreshInterval" min={0} step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS} /></DialogRow>
        <DialogRow title="Host power monitor" description="Poll host power state while clients are active."><Interval label="active host power interval" field="hostPowerMonitorActiveInterval" min={5} step={5} /></DialogRow>
        <DialogRow title="Idle host monitor" description="Poll host power state when no foreground client is active."><Interval label="idle host power interval" field="hostPowerMonitorIdleInterval" min={5} step={30} /></DialogRow>
        <Each of={[...BOOLEAN_OVERRIDES]} key={(item) => item.key}>
          {(item) => (
            <View class="flex-row items-center justify-between gap-3 border-t border-border px-4 py-3">
              <Text class="text-sm font-medium text-foreground">{item().label}</Text>
              <SettingsSwitch label={item().label} checked={resolved()[item().key]} onChange={(checked) => void writeScopedPatch(overridePatch(settings(), { [item().key]: checked }))} />
            </View>
          )}
        </Each>
      </View>
    </SettingsDialog>
  );
}

export function BackgroundActivityControl() {
  const option = () => profileOption(settings());
  return (
    <View class="flex-row items-center gap-2">
      <SettingsSelect
        label="Background activity profile"
        value={option()}
        compactWidth={160}
        options={[
          { value: "balanced", label: PROFILE_LABELS.balanced },
          { value: "performance", label: PROFILE_LABELS.performance },
          { value: "battery-saver", label: PROFILE_LABELS["battery-saver"] },
          { value: "advanced", label: PROFILE_LABELS.advanced },
        ]}
        onChange={(next) => { if (next === "advanced") dialogOpen.set(true); else void writeScopedPatch(profilePatch(next as Profile)); }}
      />
      {option() === "advanced" ? (
        <View role="button" accessibilityLabel="Configure advanced background activity" tooltip="Configure background activity" class="size-7 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out" onPress={() => dialogOpen.set(true)}>
          <SettingsIcon name="settings" size={14} />
        </View>
      ) : null}
      <AdvancedDialog />
    </View>
  );
}
