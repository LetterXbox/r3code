// AddProviderInstanceDialog.tsx: the Provider / Identity / Config wizard, as a modal above everything.
import { ChevronTurn } from "../../../components/motion/Motion";
import { computed, Scroll, signal, Text, View } from "nsh";
import { Dialog } from "nsh/base";
import { ACP_REGISTRY_WIZARD_STEPS, LOCAL_ACP_WIZARD_STEPS, officialAcpIconUrl, resolveAcpNavigation, type AcpAgent } from "./acp";
import { AcpRegistrySearchStep, createAcpRegistrySearch } from "./AcpRegistrySearchStep";
import { AccentColorPicker } from "./AccentColorPicker";
import { AddCodexAccountDialog, MultipleAccountsNote } from "./CodexSetup";
import { ProviderWizardAuthStep } from "./ProviderWizardAuthStep";
import { showToast } from "../../../components/toast";
import type { ProviderApi } from "./data";
import { deriveFields, DRIVERS, driverMeta } from "./driverMeta";
import {
  buildNewInstance, deriveAvailableInstanceId, deriveInstanceId, normalizeAccentColor, resolveWizardNavigation, validateInstanceId, WIZARD_STEPS,
  type Rec,
} from "./logic";
import { CommandArguments, FieldControl } from "./ProviderCard";
import { isManagedDriverAllowed, managedInstanceLocks } from "./policyLogic";
import { ButtonText, DraftInput, ErrorText, PillButton, ProviderIconView, Row, UiIcon } from "./ui";
import { useOverlayOpen } from "../../../components/rightPanel/nativeOcclusion";
import { Icon } from "../../../components/Icons";
import { dialogBackdropStyle, dialogPopupMotion, keepPressInDialog } from "../../../components/dialogSurface";

const FEATURED_ALL = DRIVERS.filter((meta) => meta.driver !== "acpRegistry" && meta.featured);
const MORE_ALL = DRIVERS.filter((meta) => meta.driver !== "acpRegistry" && !meta.featured);

function DriverGrid(props: { options: typeof DRIVERS; value: string; onSelect: (driver: string) => void }) {
  // ProviderRadioGrid: grid-cols-2 across the 718pt body (720 less the card border), gap 12, each card px-3 py-3 around a 20pt mark (44pt).
  return <View class="flex-row flex-wrap gap-3">
    <Each of={props.options} key={(option) => option.driver}>{(option) => <View accessibilityLabel={`Provider ${option().label}`} role="radio" accessibilityState={{ checked: props.value === option().driver }}
      testID={`driver-${option().driver}-${props.value === option().driver ? "selected" : "unselected"}`} onPress={() => props.onSelect(option().driver)}
      class={`h-11 w-[352px] flex-row items-center gap-3 rounded-lg border px-3 ${props.value === option().driver ? "border-primary bg-accent-50" : "border-border-60 bg-card-40 hover:bg-provider-row-hover"}`}>
      <ProviderIconView driver={option().driver} name={option().label} size={20} />
      <Text class="min-w-0 flex-1 text-sm font-medium text-foreground truncate">{option().label}</Text>
      {option().badgeLabel ? <View class="rounded-full bg-warning-surface px-2 py-0.5"><Text class="text-2xs font-medium text-warning-foreground">{option().badgeLabel}</Text></View> : null}
      {props.value === option().driver ? <View class="size-5 items-center justify-center rounded-full bg-primary"><UiIcon name="check" size={12} tone="foreground" /></View> : null}
    </View>}</Each>
  </View>;
}

export function AddProviderDialog(props: { api: ProviderApi; environmentLabel: string; existingIds: ReadonlySet<string>; onClose: () => void; onCreated: (instanceId: string) => void }) {
  useOverlayOpen(true, "add provider wizard");
  const step = signal(0);
  // Drivers the administrator's policy leaves out are not offered at all.
  const policy = () => props.api.managedPolicy();
  const FEATURED = FEATURED_ALL.filter((meta) => isManagedDriverAllowed(policy(), meta.driver));
  const MORE = MORE_ALL.filter((meta) => isManagedDriverAllowed(policy(), meta.driver));
  const acpAllowed = () => isManagedDriverAllowed(policy(), "acpRegistry");
  const driver = signal((FEATURED[0] ?? MORE[0])?.driver ?? (acpAllowed() ? "acpRegistry" : "codex"));
  const showMore = signal(false);
  const labelByDriver = signal<Record<string, string>>({});
  const accentByDriver = signal<Record<string, string>>({});
  const idOverrideByDriver = signal<Record<string, string | null>>({});
  const configByDriver = signal<Record<string, Rec>>({});
  const selectedAcp = signal<AcpAgent | null>(null);
  const manualAcp = signal(false);
  const createdId = signal<string | null>(null);
  const addingChatGpt = signal(false);
  const attempted = signal(false);
  const saving = signal(false);
  const error = signal("");

  const meta = () => driverMeta(driver());
  // A policy that owns this driver's launch settings also rules out ChatGPT's own runtime.
  const locks = () => managedInstanceLocks(policy(), driver());
  const locked = (key: string) => locks()?.configKeys.has(key) ? locks()?.reason : undefined;
  const isAcp = () => driver() === "acpRegistry";
  const registry = createAcpRegistrySearch(props.api, () => showMore() && step() === 0 && !(isAcp() && manualAcp()));
  const existing = computed(() => new Set(["codex", "claudeAgent", ...props.existingIds]));
  const label = () => labelByDriver()[driver()] ?? (isAcp() && selectedAcp() ? selectedAcp()?.name ?? "" : "");
  const accent = () => accentByDriver()[driver()] ?? "";
  const instanceId = () => idOverrideByDriver()[driver()] ?? deriveAvailableInstanceId((candidate) => {
    if (!candidate.trim() || candidate === meta()?.label) return driver() === "acpRegistry" ? `${driver()}_custom` : driver();
    return deriveInstanceId(driver(), candidate);
  }, label(), existing());
  const idError = () => validateInstanceId(instanceId(), existing());
  const config = () => configByDriver()[driver()] ?? {};
  const fields = () => { const m = meta(); return m ? deriveFields(m, config()) : []; };
  const showIdError = () => attempted() && idError() !== null;
  const isLocalAcp = () => isAcp() && manualAcp() && config().source === "local";
  const localCommand = () => typeof config().commandPath === "string" ? (config().commandPath as string).trim() : "";
  const manualAgentId = () => typeof config().agentId === "string" ? (config().agentId as string).trim() : "";
  const acpSelectionError = () => isLocalAcp() ? (localCommand().length > 0 ? null : "Executable is required.")
    : selectedAcp() !== null || (manualAcp() && manualAgentId().length > 0) ? null : "Select an ACP or configure one manually.";
  const steps = (): readonly string[] => isAcp() ? (isLocalAcp() ? LOCAL_ACP_WIZARD_STEPS : ACP_REGISTRY_WIZARD_STEPS) : WIZARD_STEPS;
  const busy = () => saving() || registry.preparingId() !== null || createdId() !== null;
  const lastFormStep = () => isAcp() ? 1 : 2;

  function selectDriver(value: string) { driver.set(value); manualAcp.set(false); attempted.set(false); error.set(""); }
  function go(requested: number) {
    if (busy()) return;
    const result = isAcp()
      ? resolveAcpNavigation(step(), requested, { instanceIdError: idError(), selectionError: acpSelectionError(), local: isLocalAcp() })
      : resolveWizardNavigation(step(), requested, WIZARD_STEPS.length, { instanceIdError: idError() });
    if (result.kind === "blocked") attempted.set(true);
    if (isAcp() && !isLocalAcp() && result.kind === "navigate" && result.step === 2) { void save(); return; }
    step.set(result.step);
  }
  function updateConfig(next: Rec | undefined) {
    configByDriver.update((all) => { const copy = { ...all }; if (!next || Object.keys(next).length === 0) delete copy[driver()]; else copy[driver()] = next; return copy; });
  }
  function acpPrepared(agent: AcpAgent) {
    driver.set("acpRegistry");
    const nextId = deriveAvailableInstanceId((candidate) => deriveInstanceId("acpRegistry", candidate), agent.name, existing());
    selectedAcp.set(agent); manualAcp.set(false);
    labelByDriver.update((all) => ({ ...all, acpRegistry: agent.name }));
    idOverrideByDriver.update((all) => ({ ...all, acpRegistry: nextId }));
    const icon = officialAcpIconUrl(agent.icon);
    configByDriver.update((all) => ({ ...all, acpRegistry: { agentId: agent.id, distribution: "auto", ...(icon ? { registryIconUrl: icon } : {}) } }));
    attempted.set(false); step.set(1);
  }
  function acpManual(local: boolean) {
    driver.set("acpRegistry"); selectedAcp.set(null); manualAcp.set(true);
    configByDriver.update((all) => { const copy = { ...all }; if (local) copy.acpRegistry = { source: "local", commandArgs: [] }; else delete copy.acpRegistry; return copy; });
    labelByDriver.update((all) => ({ ...all, acpRegistry: local ? "Local ACP" : "" }));
    idOverrideByDriver.update((all) => ({ ...all, acpRegistry: null }));
    attempted.set(false);
  }
  async function save() {
    if (saving() || createdId() !== null) return;
    attempted.set(true);
    if (idError() !== null || (isAcp() && acpSelectionError() !== null)) return;
    saving.set(true); error.set("");
    const id = instanceId();
    try {
      await props.api.mutate({ operation: "create", instanceId: id, instance: buildNewInstance({ driver: driver(), label: label(), accentColor: accent(), config: config() }) });
      props.onCreated(id);
      if (isAcp() && !isLocalAcp()) { createdId.set(id); step.set(2); } else {
        showToast({ type: "success", title: "Provider instance added", description: `${meta()?.label ?? driver()} instance '${id}' was added.` });
        props.onClose();
      }
    } catch (cause) { error.set(cause instanceof Error ? cause.message : "Could not add provider instance."); }
    finally { saving.set(false); }
  }

  const summary = (index: number): string | null => index === 0 ? (isAcp() ? (isLocalAcp() ? "Local ACP command" : selectedAcp()?.name ?? (manualAgentId() || null)) : meta()?.label ?? null)
    : index === 1 ? (label().trim() || `${meta()?.label ?? driver()} Workspace`) : null;

  return <>{addingChatGpt() ? <AddCodexAccountDialog api={props.api} canManage onClose={props.onClose} onAccountCreated={(id) => props.onCreated(id)} /> : <Dialog open animation="fade" onCancel={props.onClose} onOpenChange={({ open }) => { if (!open) props.onClose(); }} closeOnBackdropPress={false} testID="Add provider dialog"
    backdropStyle={dialogBackdropStyle()} style={[{ margin: "auto", width: 768, maxWidth: "92%", maxHeight: "92%" }, dialogPopupMotion()]}>
    <View class="max-h-full w-full flex-col overflow-hidden rounded-2xl border border-border bg-background" onPress={keepPressInDialog}>
    {/* Show more trigger: Button size xs is sm:h-6 (24pt); WizardPanel's pt-2 after the grid, so no extra margin. */}
    {/* DialogPopup showCloseButton: a ghost icon button at end-2 top-2. */}
    <View role="button" accessibilityLabel="Close" onPress={props.onClose} class="absolute right-2 top-2 z-10 size-8 items-center justify-center rounded-lg hover:bg-accent"><Icon name="x" size={16} /></View>
    <View class="shrink-0 gap-2 border-b border-border px-6 pt-6 pb-[11px]">
      <Text class="text-xl leading-snug font-semibold text-foreground">Add provider</Text>
      <Text class="text-sm text-muted-foreground">{`Add an account or configure a provider on ${props.environmentLabel}.`}</Text>
      <View class="flex-row gap-1 rounded-xl border border-border-60 bg-background p-[3px]" testID="Setup progress">
        <Each of={steps().map((name, index) => ({ name, index }))} key={(entry) => entry.name}>{(entry) => <View accessibilityLabel={`${entry().name}, step ${entry().index + 1}${entry().index < step() && summary(entry().index) ? `, ${summary(entry().index)}` : ""}`}
          accessibilityState={{ selected: step() === entry().index }} role="button" disabled={busy()} onPress={() => go(entry().index)}
          class={`min-w-0 flex-1 flex-row items-center gap-2 rounded-lg px-2.5 py-2 ${step() === entry().index ? "bg-card" : "hover:bg-card"}`}>
          <View class={`size-5 items-center justify-center rounded-full border ${entry().index < step() ? "border-primary bg-primary" : step() === entry().index ? "border-primary bg-card" : "border-border-60 bg-card"}`}>
            {entry().index < step() ? <UiIcon name="check" size={12} tone="foreground" /> : <Text class={step() === entry().index ? "text-xs font-medium text-primary" : "text-xs font-medium text-muted-foreground"}>{String(entry().index + 1)}</Text>}
          </View>
          <Text class={`min-w-0 text-sm font-medium truncate ${step() === entry().index ? "text-foreground" : "text-muted-foreground"}`}>{entry().name}</Text>
        </View>}</Each>
      </View>
    </View>

    {createdId() !== null ? <Scroll class="flex-1" contentClass="px-6 py-5"><ProviderWizardAuthStep api={props.api} environmentLabel={props.environmentLabel} instanceId={createdId() as string} onFinish={props.onClose} /></Scroll> : <>
    <Scroll class="shrink bg-background" contentClass="gap-4 px-6 py-5">
      {step() === 0 ? <View class="gap-2">
        <Text class="text-sm font-medium text-foreground">Provider</Text>
        <DriverGrid options={FEATURED} value={isAcp() ? "" : driver()} onSelect={selectDriver} />
        {driver() === "codex" || driver() === "claudeAgent" ? <MultipleAccountsNote api={props.api} driver={driver() as "codex"} /> : null}
        <View accessibilityLabel={showMore() ? "Show less providers" : "Show more providers"} role="button" onPress={() => showMore.set(!showMore())} class="h-6 flex-row items-center gap-1 self-start rounded-md px-[7px] hover:bg-accent-50">
          <Text class="text-xs text-muted-foreground">{showMore() ? "Show less" : "Show more"}</Text><ChevronTurn open={showMore} degrees={180}><UiIcon name="chevron-down" size={12} /></ChevronTurn>
        </View>
        {showMore() ? <View class="gap-4 pt-2">
          <DriverGrid options={MORE} value={isAcp() ? "" : driver()} onSelect={selectDriver} />
          {acpAllowed() ? <View class="gap-4"><View class="flex-row items-center gap-3"><View class="h-px flex-1 bg-border-70" /><Text class="text-xs text-muted-foreground">Or choose from ACP Registry</Text><View class="h-px flex-1 bg-border-70" /></View>
          {isAcp() && manualAcp() ? <View class="gap-4" testID="ACP manual configuration">
            <View class="flex-row items-start justify-between gap-3">
              <View class="gap-0.5">
                <Text class="text-sm font-medium text-foreground">{isLocalAcp() ? "Local ACP command" : "Enter manually"}</Text>
                <Text class="text-xs text-muted-foreground">{isLocalAcp() ? `Run an installed ACP executable on ${props.environmentLabel}.` : "Enter an official registry ID and any local executable or auth override."}</Text>
              </View>
              <PillButton label="Search registry" size="xs" variant="ghost" onPress={() => { manualAcp.set(false); attempted.set(false); }}><ButtonText tone="muted">Search registry</ButtonText></PillButton>
            </View>
            <View class="overflow-hidden"><Each of={fields()} key={(field) => field.key}>{(field, index) => <Row title={field().label} description={field().description} divider={false} managed={locked(field().key)}
              control={<FieldControl field={field()} config={config()} disabled={saving()} onChange={updateConfig} />} />}</Each>
              {isLocalAcp() ? <CommandArguments divider={false} config={config()} disabled={saving()} managed={locked("commandArgs")} onChange={(next) => updateConfig(next)} /> : null}</View>
            {attempted() && acpSelectionError() ? <ErrorText>{acpSelectionError()}</ErrorText> : null}
          </View> : <View class="gap-2">
            <AcpRegistrySearchStep api={props.api} registry={registry} providerInstances={props.api.instances()} canManage onPrepared={acpPrepared} onManualConfiguration={() => acpManual(false)} onLocalConfiguration={() => acpManual(true)} />
            {isAcp() && attempted() && acpSelectionError() ? <ErrorText>{acpSelectionError()}</ErrorText> : null}
          </View>}
          </View> : null}
        </View> : null}
      </View> : null}

      {step() === 1 ? <View class="gap-0">
        {isAcp() && selectedAcp() ? <View class="mb-4 flex-row items-start justify-between gap-3 border-b border-border-70 pb-3" testID="Selected ACP agent">
          <View class="min-w-0 flex-1">
            <Text class="text-sm font-medium text-foreground truncate">{selectedAcp()?.name}</Text>
            <Text class="mt-0.5 text-xs text-muted-foreground">{`v${selectedAcp()?.version} · ${selectedAcp()?.distribution}`}</Text>
          </View>
          <View class="shrink-0 flex-row gap-2">
            {selectedAcp()?.website ? <View accessibilityLabel={`Open documentation for ${selectedAcp()?.name} (${selectedAcp()?.id})`} role="link" onPress={() => props.api.openExternal(selectedAcp()?.website as string)}><Text class="text-2xs text-muted-foreground">Docs</Text></View> : null}
            {selectedAcp()?.repository ? <View accessibilityLabel={`Open source for ${selectedAcp()?.name} (${selectedAcp()?.id})`} role="link" onPress={() => props.api.openExternal(selectedAcp()?.repository as string)}><Text class="text-2xs text-muted-foreground">Source</Text></View> : null}
          </View>
        </View> : null}
        <Row divider={false} title="Label" description="Shown in the provider list."
          control={<DraftInput label="Provider label" value={label()} placeholder="e.g. Work" class="w-56" onCommit={(next) => labelByDriver.update((all) => ({ ...all, [driver()]: next }))} />} />
        <Row divider={false} title="Instance ID" description="Letters, digits, '-', or '_'." status={showIdError() ? <ErrorText>{idError()}</ErrorText> : undefined}
          control={<DraftInput label="Instance ID" mono value={instanceId()} placeholder={`${driver()}_work`} class="w-56" onCommit={(next) => idOverrideByDriver.update((all) => ({ ...all, [driver()]: next.trim() }))} />} />
        <Row divider={false} title="Accent color" description="Optional marker shown in the picker."
          control={<AccentColorPicker name={label() || meta()?.label || ""} value={normalizeAccentColor(accent())} disabled={false} onCommit={(next) => accentByDriver.update((all) => ({ ...all, [driver()]: normalizeAccentColor(next) ?? "" }))} />} />
      </View> : null}

      {step() === 2 && !isAcp() ? (fields().length === 0
        ? <Text class="text-sm text-muted-foreground">This driver has no required configuration. You can add the instance now.</Text>
        : <View><Each of={fields()} key={(field) => field.key}>{(field) => <Row title={field().label} description={field().description} divider={false} managed={locked(field().key)}
          control={<FieldControl field={field()} config={config()} disabled={saving()} onChange={updateConfig} />} />}</Each></View>) : null}
      {error() ? <ErrorText>{error()}</ErrorText> : null}
    </Scroll>

    {/* DialogFooter (ui/dialog.tsx): border-t bg-muted/72 py-4 px-6; the ref edge is a ring (no layout), so the 1pt border comes out of the padding. Same for the header pb-3. */}
    <View class="shrink-0 flex-row items-center justify-end gap-2 border-t border-border bg-muted-72 px-6 pt-[15px] pb-4">
      <PillButton label={step() === 0 ? "Cancel add provider" : "Back"} variant={step() === 0 ? "ghost" : "outline"} disabled={saving() || registry.preparingId() !== null}
        onPress={() => { if (step() === 0) props.onClose(); else step.set(Math.max(0, step() - 1)); }}><ButtonText tone={step() === 0 ? "muted" : "default"}>{step() === 0 ? "Cancel" : "Back"}</ButtonText></PillButton>
      {step() === 0 && driver() === "codex" ? <>
        <PillButton label="Configure manually" onPress={() => go(1)}><ButtonText>Configure manually</ButtonText></PillButton>
        {locks()?.configKeys.has("setupMode") ? null : <PillButton label="Continue with ChatGPT" variant="primary" onPress={() => addingChatGpt.set(true)}><ProviderIconView driver="codex" name="OpenAI" size={20} /><ButtonText tone="primary">Continue with ChatGPT</ButtonText></PillButton>}
      </> : step() < lastFormStep() ? <PillButton label="Next" variant="primary" disabled={registry.preparingId() !== null} onPress={() => go(step() + 1)}><ButtonText tone="primary">Next</ButtonText></PillButton>
        : <PillButton label="Add provider instance" variant="primary" disabled={saving()} onPress={() => void save()}><ButtonText tone="primary">{saving() ? "Adding..." : isAcp() && !isLocalAcp() ? "Continue to sign-in" : "Add instance"}</ButtonText></PillButton>}
    </View>
    </>}
    </View>
  </Dialog>}</>;
}
