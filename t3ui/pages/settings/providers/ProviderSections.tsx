// The sections under the provider list in ProviderSettingsPanel.tsx: Usage providers
// (UsageProviderSettings.tsx + AddUsageLimitSourceDialog.tsx) and Advanced (the health-check interval).
import { effect, signal, Text, View } from "nsh";
import { Dialog } from "nsh/base";
import { SettingResetButton } from "../../../components/SettingsLayout";
import type { ProviderApi } from "./data";
import { defaultProviderHealthSeconds, normalizeIntervalSeconds, PROVIDER_HEALTH_INTERVAL_STEP_SECONDS, providerHealthPatch, providerHealthSeconds } from "./advanced";
import { rec } from "./logic";
import { createStepperKeys } from "../../../components/stepperKeys";
import { sourceIdFromUrl, usageSources, type UsageSource } from "./usageSources";
import { ButtonText, DraftInput, ErrorText, PillButton, Row, Section, UiIcon } from "./ui";
import { useOverlayOpen } from "../../../components/rightPanel/nativeOcclusion";
import { dialogBackdropStyle, dialogPopupMotion, keepPressInDialog } from "../../../components/dialogSurface";
import { DialogCloseButton } from "../../../components/DialogCloseButton";

function errorText(cause: unknown, fallback: string): string { return cause instanceof Error && cause.message ? cause.message : fallback; }

/** IntervalSecondsField: a w-32 number group with decrease and increase steps, committed on blur or return. */
export function IntervalSecondsField(props: { label: string; value: number; min: number; step: number; disabled?: boolean; onCommit: (seconds: number) => void }) {
  const draft = signal<string | null>(null);
  const shown = () => draft() ?? String(props.value);
  const commit = (raw: string | number) => {
    const parsed = typeof raw === "number" ? raw : raw.trim() === "" ? null : Number(raw);
    const seconds = normalizeIntervalSeconds(parsed, props.min);
    draft.set(null);
    if (seconds !== props.value) props.onCommit(seconds);
  };
  const step = (direction: 1 | -1) => { if (!props.disabled) commit(Math.max(props.min, props.value + direction * props.step)); };
  const capitalized = `${props.label.charAt(0).toUpperCase()}${props.label.slice(1)}`;
  // NumberField min `min`, step `step` (IntervalSecondsField.tsx): the arrows step the saved value.
  const keys = createStepperKeys(() => props.value, (next) => { if (!props.disabled) commit(next); }, () => ({ min: props.min, step: props.step }));
  return <View class={`h-8 w-32 flex-row items-center overflow-hidden rounded-md border border-input bg-background ${props.disabled ? "opacity-64" : ""}`}>
    <View accessibilityLabel={`Decrease ${props.label}`} role="button" disabled={props.disabled} onPress={() => step(-1)} class="h-full w-8 items-center justify-center hover:bg-accent-50 transition-colors duration-150 ease-in-out"><Text class="text-sm text-muted-foreground">-</Text></View>
    <DraftInput label={`${capitalized} in seconds`} value={shown()} disabled={props.disabled} class="h-full min-w-0 flex-1 rounded-none border-0 px-1 text-center" onCommit={commit} onFocus={keys.onFocus} onBlur={keys.onBlur} />
    <View accessibilityLabel={`Increase ${props.label}`} role="button" disabled={props.disabled} onPress={() => step(1)} class="h-full w-8 items-center justify-center hover:bg-accent-50 transition-colors duration-150 ease-in-out"><Text class="text-sm text-muted-foreground">+</Text></View>
  </View>;
}

/** The Advanced section: provider health-check interval in seconds. */
export function ProviderAdvancedSection(props: { api: ProviderApi; readOnly: boolean }) {
  const error = signal("");
  const settings = () => props.api.settings();
  const seconds = () => providerHealthSeconds(settings());
  async function write(patch: Record<string, unknown>) {
    error.set("");
    try { await props.api.updateSettings(patch); } catch (cause) { error.set(errorText(cause, "Could not save the health check interval.")); }
  }
  return <Section title="Advanced">
    <Row divider={false} testID="Provider health check interval"
      title="Health check interval"
      description="Refresh provider status, versions, and models in the background. Set to 0 to disable."
      resetAction={seconds() !== defaultProviderHealthSeconds(settings()) && !props.readOnly
        ? <SettingResetButton label="provider health check interval" onPress={() => void write(providerHealthPatch(settings(), undefined))} /> : null}
      control={<View class="flex-row shrink-0 items-center gap-2">
        <IntervalSecondsField label="provider health check interval" value={seconds()} min={0} step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS} disabled={props.readOnly}
          onCommit={(next) => void write(providerHealthPatch(settings(), next))} />
        <Text class="text-xs text-muted-foreground">seconds</Text>
      </View>}>
      {error() ? <ErrorText>{error()}</ErrorText> : null}
    </Row>
  </Section>;
}

function AddHubDialog(props: { api: ProviderApi; environmentLabel: string; sources: UsageSource[]; onClose: () => void }) {
  useOverlayOpen(true, "add usage hub");
  const label = signal(""); const url = signal(""); const key = signal(""); const error = signal(""); const saving = signal(false);
  const canSave = () => url().trim().length > 0 && key().trim().length > 0 && !saving();
  async function save() {
    if (!canSave()) return;
    saving.set(true); error.set("");
    const id = sourceIdFromUrl(url().trim(), props.sources);
    try {
      await props.api.updateSettings({ usageLimitSources: { [id]: { kind: "cliproxy", ...(label().trim() ? { label: label().trim() } : {}), url: url().trim(), managementKey: key().trim(), enabled: true } } });
      props.onClose();
    } catch (cause) { error.set(errorText(cause, "Could not add the hub.")); }
    finally { saving.set(false); }
  }
  const field = (title: string, input: any) => <View class="gap-1.5"><Text class="text-sm font-medium text-foreground">{title}</Text>{input}</View>;
  return <Dialog open animation="fade" onCancel={props.onClose} onOpenChange={({ open }) => { if (!open) props.onClose(); }} closeOnBackdropPress={false} testID="Add usage hub dialog"
    backdropStyle={dialogBackdropStyle()} style={[{ margin: "auto", width: 448, maxWidth: "92%" }, dialogPopupMotion()]}>
    <View class="relative w-full flex-col overflow-hidden rounded-2xl border border-border bg-background" onPress={keepPressInDialog}>
      <DialogCloseButton onClose={props.onClose} />
      <View class="gap-1 px-6 pt-5 pb-4">
        <Text class="text-lg font-semibold text-foreground">Add a CLIProxyAPI hub</Text>
        <Text class="text-sm text-muted-foreground">{`Show the quota of every account the hub pools, next to the providers on ${props.environmentLabel}. The key stays on that server.`}</Text>
      </View>
      <View class="gap-4 px-6 pb-4">
        {field("Hub URL", <DraftInput label="Hub URL" value={url()} placeholder="https://hub.example.ts.net:8318" class="w-full" onCommit={(next) => url.set(next)} />)}
        {field("Management key", <DraftInput label="Management key" masked value={key()} class="w-full" onCommit={(next) => key.set(next)} />)}
        {field("Label (optional)", <DraftInput label="Hub label" value={label()} placeholder="Defaults to the hub's host name" class="w-full" onCommit={(next) => label.set(next)} />)}
        {error() ? <ErrorText>{error()}</ErrorText> : null}
      </View>
      <View class="flex-row items-center justify-end gap-2 px-6 pb-5">
        <PillButton label="Cancel add hub" onPress={props.onClose}><ButtonText>Cancel</ButtonText></PillButton>
        <PillButton label="Add hub" variant="primary" disabled={!canSave()} onPress={() => void save()}><ButtonText tone="primary">Add hub</ButtonText></PillButton>
      </View>
    </View>
  </Dialog>;
}

function RemoveHubDialog(props: { label: string; onConfirm: () => void; onClose: () => void }) {
  useOverlayOpen(true, "remove usage hub");
  return <Dialog open animation="fade" onCancel={props.onClose} onOpenChange={({ open }) => { if (!open) props.onClose(); }} testID="Remove usage hub dialog"
    backdropStyle={dialogBackdropStyle()} style={[{ margin: "auto", width: 448, maxWidth: "92%" }, dialogPopupMotion()]}>
    <View class="w-full flex-col gap-4 overflow-hidden rounded-2xl border border-border bg-background px-6 py-5" onPress={keepPressInDialog}>
      <View class="gap-1">
        <Text class="text-lg font-semibold text-foreground">{`Remove ${props.label}?`}</Text>
        <Text class="text-sm text-muted-foreground">The hub's management key is deleted from this server. Its accounts leave the Limits view; the hub itself is untouched. Add it again with the URL and key to bring them back.</Text>
      </View>
      <View class="flex-row items-center justify-end gap-2">
        <PillButton label="Cancel remove hub" onPress={props.onClose}><ButtonText>Cancel</ButtonText></PillButton>
        <PillButton label="Confirm remove hub" onPress={props.onConfirm}><ButtonText tone="destructive">Remove hub</ButtonText></PillButton>
      </View>
    </View>
  </Dialog>;
}

/** The Usage providers section: CLIProxyAPI hubs that add accounts to the Limits view. */
export function UsageProviders(props: { api: ProviderApi; environmentLabel: string; readOnly: boolean }) {
  const adding = signal(false);
  const removing = signal<{ id: string; label: string } | null>(null);
  const error = signal("");
  const sources = () => usageSources(rec(props.api.settings().usageLimitSources) ?? undefined);
  effect(() => { if (props.readOnly) adding.set(false); });
  async function remove(id: string) {
    error.set("");
    try { await props.api.updateSettings({ usageLimitSources: { [id]: null } }); } catch (cause) { error.set(errorText(cause, "Could not remove the hub.")); }
  }
  return <>
    <Section title="Usage providers"
      action={!props.readOnly ? <PillButton label="Add hub" size="xs" onPress={() => adding.set(true)}><UiIcon name="plus" size={12} /><ButtonText>Add hub</ButtonText></PillButton> : null}>
      {sources().length === 0 ? <Row divider={false} title="No hubs configured." /> : <Each of={sources()} key={(source) => source.id}>{(source, index) =>
        <Row divider={index() > 0} title={source().label} description={`CLI Proxy${source().enabled ? "" : " · Disabled"}${source().label !== source().url ? ` · ${source().url}` : ""}`}
          control={!props.readOnly ? <PillButton label={`Remove ${source().label}`} size="xs" variant="ghost" onPress={() => removing.set({ id: source().id, label: source().label })}><ButtonText>Remove</ButtonText></PillButton> : null} />}</Each>}
      {error() ? <View class="px-4 pb-3"><ErrorText>{error()}</ErrorText></View> : null}
    </Section>
    {adding() && !props.readOnly ? <AddHubDialog api={props.api} environmentLabel={props.environmentLabel} sources={sources()} onClose={() => adding.set(false)} /> : null}
    {removing() ? <RemoveHubDialog label={removing()?.label ?? ""} onClose={() => removing.set(null)} onConfirm={() => { const target = removing(); removing.set(null); if (target) void remove(target.id); }} /> : null}
  </>;
}
