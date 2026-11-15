// ProviderInstanceCard.tsx: one provider instance as a list row and as the editor beside the list.
import { computed, effect, signal, Text, View } from "nsh";
import { Popover, Switch } from "nsh/base";
import { trackOpenChange, useOverlayOpen } from "../../../components/rightPanel/nativeOcclusion";
import { SettingsSelect } from "../../../components/SettingsLayout";
import { SecretSourceInput } from "../SecretSourceInput";
import { currentSecretSources } from "../secretSource";
import type { ProviderApi } from "./data";
import { showToast } from "../../../components/toast";
import { SettingsIcon } from "../SettingsIcon";
import { deriveFields, driverMeta, type DriverEnvField, type DriverField } from "./driverMeta";
import {
  ACCENT_PALETTE, cleanEnvironment, displayName, ENV_NAME_PATTERN, envVariable, envWithoutNames, modelsForDisplay, nextConfigWithField, nextEnvWithFieldValue, nextEnvWithFieldSecret,
  normalizeAccentColor, providerSummary, readConfigString, readCustomModels, resolveInstanceEnabled, secretConfigured, statusKey, STATUS_DOT_CLASS,
  toCustomModelSetting, versionAdvisoryPresentation, versionLabel,
  type CustomModel, type EnvVar, type InstanceConfig, type InstanceRow, type ProviderView,
} from "./logic";
import { AccentColorPicker } from "./AccentColorPicker";
import { ProviderAuthentication, ProviderRuntime } from "./ProviderAuth";
import { CodexManagedRuntimeFields, CodexManagedSetup, readCodexSetupMode } from "./CodexSetup";
import { ProviderModels } from "./ProviderModels";
import { AcpSessionManagement } from "./AcpSessionManagement";
import { ConfirmDialog } from "./ConfirmDialog";
import { ManagedNotice } from "./ManagedPolicy";
import { ProviderAuthEmail } from "./RedactedText";
import { disallowedProviderMessage, isManagedDriverAllowed, managedInstanceLocks } from "./policyLogic";
import { ButtonText, DraftInput, ErrorText, FoldedSection, IconButton, ManagedControl, PillButton, ProviderIconView, Row, Section, Tip, UiIcon } from "./ui";

export interface CardCommon {
  api: ProviderApi;
  row: InstanceRow;
  live: ProviderView | undefined;
  /** Disconnected or showing the on-disk cache: nothing can be changed. */
  readOnly: boolean;
  updating: boolean;
  onRunUpdate: (targetVersion?: string) => void;
}

function instanceOf(row: InstanceRow): InstanceConfig { return row.explicit ?? { driver: row.driver }; }
function enabledOf(row: InstanceRow, live: ProviderView | undefined): boolean {
  if (row.explicit) return resolveInstanceEnabled(row.explicit);
  return live?.cached ? live.enabled : resolveInstanceEnabled({ driver: row.driver });
}
function nameOf(row: InstanceRow, live: ProviderView | undefined): string {
  // The live snapshot's name only stands in for a cached row; a connected page shows the configured name or the driver label.
  return displayName(instanceOf(row), instanceOf(row).displayName || !live?.cached ? undefined : live.displayName ?? undefined);
}

/** The update/compatibility indicator and its details popover (versionAdvisoryNode). */
function AdvisoryPopover(props: CardCommon & { size: number }) {
  const enabled = () => enabledOf(props.row, props.live);
  const advisory = computed(() => props.live ? versionAdvisoryPresentation(props.live.versionAdvisory, props.live.compatibilityAdvisory, enabled()) : null);
  const compat = () => props.live?.compatibilityAdvisory;
  const warn = () => compat() !== null && compat() !== undefined && compat()?.status !== "supported" && compat()?.status !== "unknown";
  const state = () => props.live?.updateState;
  const progress = () => props.updating ? ((state()?.status === "queued" || state()?.status === "running" ? state()?.message : null) ?? "Starting update") : null;
  const problem = () => !props.updating && (state()?.status === "failed" || state()?.status === "unchanged") ? state()?.message ?? null : null;
  const canRun = () => !props.readOnly && props.live !== undefined && !props.live.cached && (advisory()?.targetVersion ? props.live.versionAdvisory?.canInstallVersion === true : props.live.versionAdvisory?.canUpdate === true);
  const copied = signal(false);
  const open = signal(false);
  useOverlayOpen(() => open(), "provider advisory");
  return <View>{advisory() ? <Popover placement="bottom" align="end" offset={6} open={open()} onOpenChange={trackOpenChange(open)}
    popupClass="w-72 gap-3 rounded-lg border border-border bg-popover-84 p-3"
    trigger={<View accessibilityLabel={`${progress() ? "Updating" : advisory()?.title}, view details`} role="button" tooltip={<Tip label={progress() ? "Updating" : advisory()?.title} />} class={`${props.size > 14 ? "size-6 rounded-lg" : "size-5 rounded-sm"} items-center justify-center hover:bg-accent-50`}>
      <UiIcon name={progress() ? "loader-circle" : warn() ? "triangle-alert" : "circle-arrow-up"} size={props.size} tone={warn() ? "warning" : "muted"} /></View>}>
    <View class="gap-3">
      <View class="gap-0.5">
        <Text class="text-sm font-semibold text-foreground">{advisory()?.title}</Text>
        <Text class={advisory()?.emphasis === "strong" ? "text-xs text-warning" : "text-xs text-muted-foreground"}>{advisory()?.detail}</Text>
      </View>
      {canRun() ? <PillButton label={props.updating ? "Updating" : advisory()?.targetVersion ? `Install ${versionLabel(advisory()?.targetVersion)}` : "Update now"} size="xs" disabled={props.updating}
        onPress={() => props.onRunUpdate(advisory()?.targetVersion ?? undefined)}>
        <UiIcon name="download" size={12} /><ButtonText>{props.updating ? "Updating" : advisory()?.targetVersion ? `Install ${versionLabel(advisory()?.targetVersion)}` : "Update now"}</ButtonText></PillButton> : null}
      {progress() || problem() ? <Text class={problem() ? "text-xs text-warning" : "text-xs text-muted-foreground"}>{progress() ?? problem()}</Text> : null}
      {canRun() && advisory()?.updateCommand ? <View class="flex-row items-center gap-2"><View class="h-px flex-1 bg-border" /><Text class="text-[10px] font-medium text-muted-foreground">OR, UPDATE MANUALLY USING</Text><View class="h-px flex-1 bg-border" /></View> : null}
      {advisory()?.updateCommand ? <View class="flex-row items-center gap-1 rounded-md border border-border-70 bg-muted-40 py-0.5 pr-0.5 pl-2">
        <Text class="min-w-0 flex-1 font-mono text-2xs text-foreground truncate">{advisory()?.updateCommand}</Text>
        <IconButton label="Copy update command" tooltip="Copy command" icon={copied() ? "check" : "copy"} size={12} onPress={() => {
          props.api.copy(advisory()?.updateCommand as string); copied.set(true);
          // ProviderInstanceCard.tsx:793-799: the copy is confirmed with a toast naming the provider.
          showToast({ type: "success", title: `${nameOf(props.row, props.live)} update command copied`, description: "Run it in a terminal when you are ready to update." });
        }} />
      </View> : null}
    </View>
  </Popover> : null}</View>;
}

/** The list row: icon, name and version, status line, enable switch. */
/** ProjectOverrideControl: in a project scope the switch edits that project's enablement of the instance. */
export interface ProjectOverride { value: boolean | undefined; onChange: (next: boolean) => void; onReset: () => void }

export function ProviderListRow(props: CardCommon & { selected: boolean; error: string | undefined; pending: boolean; onSelect: () => void; onToggle: (enabled: boolean) => void; projectOverride?: ProjectOverride; canWriteSettings?: boolean }) {
  const deviceEnabled = () => enabledOf(props.row, props.live);
  const enabled = () => props.projectOverride?.value ?? deviceEnabled();
  const view = (): ProviderView | undefined => props.live ? { ...props.live, enabled: enabled() } : undefined;
  const key = () => enabled() ? statusKey(view()) : "disabled";
  const summary = () => enabled() ? providerSummary(view()) : { headline: "Disabled", detail: null };
  const attention = () => key() === "warning" || key() === "error";
  const compat = () => enabled() ? props.live?.compatibilityAdvisory : undefined;
  const hasCompat = () => compat() !== undefined && compat() !== null && compat()?.status !== "supported" && compat()?.status !== "unknown";
  const inlineDetail = () => hasCompat() ? (compat()?.status === "broken" ? "Incompatible" : compat()?.status === "unsupported" ? "Unsupported" : "Limited support") : summary().detail;
  const updateProgress = () => props.updating ? ((props.live?.updateState?.status === "queued" || props.live?.updateState?.status === "running" ? props.live.updateState.message : null) ?? "Starting update") : null;
  const name = () => nameOf(props.row, props.live);
  const driver = () => props.row.driver;
  const ver = () => versionLabel(props.live?.version);
  const dim = () => !enabled() && !props.selected;
  const managedDriverReason = () => isManagedDriverAllowed(props.api.managedPolicy(), driver()) ? undefined : disallowedProviderMessage(props.api.managedPolicy()?.organization, driverMeta(driver())?.label ?? driver());
  return <View testID={`provider-${props.row.instanceId}-${props.selected ? "selected" : "unselected"}`}
    class={`min-h-[72px] flex-row items-center gap-3 border-b border-border-50 px-4 py-3 ${props.selected ? "bg-provider-row-selected" : "hover:bg-provider-row-hover"} transition-colors duration-150 ease-in-out`}>
    <View accessibilityLabel={`Select ${name()}`} accessibilityState={{ selected: props.selected }} role="button" onPress={props.onSelect}
      class={`min-w-0 flex-1 flex-row items-start gap-3 ${dim() ? "opacity-60" : ""}`}>
      <View class="pt-0.5"><ProviderIconView driver={driver()} instanceId={props.row.instanceId} name={name()} accentColor={instanceOf(props.row).accentColor} badge={normalizeAccentColor(instanceOf(props.row).accentColor) !== undefined} /></View>
      <View class="min-w-0 flex-1 gap-0.5">
        <View class="flex-row items-center gap-2">
          <Text class="min-w-0 shrink text-sm font-medium text-foreground truncate">{name()}</Text>
          {ver() ? <Text class="max-w-24 shrink-0 font-mono text-xs text-muted-foreground truncate">{ver()}</Text> : null}
          <AdvisoryPopover api={props.api} row={props.row} live={props.live} readOnly={props.readOnly} updating={props.updating} onRunUpdate={props.onRunUpdate} size={14} />
        </View>
        <View class="flex-row items-start gap-1.5">
          {attention() && !updateProgress() ? <View class="mt-[7px] size-1.5 rounded-full" classList={{ [STATUS_DOT_CLASS[key()]]: true }} /> : null}
          <Text class="min-w-0 flex-1 text-xs leading-normal text-muted-foreground-80 line-clamp-2">
            {updateProgress() ? `Updating · ${updateProgress()}` : `${summary().headline}${attention() && inlineDetail() ? ` · ${inlineDetail()}` : ""}`}
          </Text>
        </View>
        {props.error ? <ErrorText>{props.error}</ErrorText> : null}
      </View>
    </View>
    {props.projectOverride?.value !== undefined ? (
      // ProjectOverrideInheritance and its reset (ProviderInstanceCard.tsx:588-615, 1143-1156).
      <View class="flex-row items-center">
        <View role="button" accessibilityLabel="Overridden for this project. Show where this value comes from" tooltip={<Tip label={`Overridden for this project · Project ${props.projectOverride.value ? "on" : "off"}, device ${deviceEnabled() ? "on" : "off"}`} />} class="size-5 items-center justify-center rounded-md hover:bg-accent-50">
          <SettingsIcon name="layers" size={12} />
        </View>
        <View role="button" accessibilityLabel={`Reset ${name()} enablement to default`} tooltip={<Tip label="Reset to the device setting" />} disabled={props.readOnly || props.canWriteSettings === false} onPress={() => props.projectOverride?.onReset()} class="size-5 items-center justify-center rounded-md hover:bg-accent-50">
          <UiIcon name="undo-2" size={12} />
        </View>
      </View>
    ) : null}
    {/* The policy refuses switching it on; switching it off stays the user's call. */}
    <ManagedControl reason={enabled() ? undefined : managedDriverReason()}>
      <Switch checked={enabled()} disabled={props.readOnly || props.pending || (props.projectOverride !== undefined && props.canWriteSettings === false)} onChange={(event: { checked?: boolean }) => (props.projectOverride ? props.projectOverride.onChange(event.checked === true) : props.onToggle(event.checked === true))}
        accessibilityLabel={`Enable ${name()}`} testID={`${name()} enabled ${enabled() ? "on" : "off"}`}
        class="h-[18px] w-[30px] items-center" trackClass="h-[18px] w-[30px] justify-center rounded-full bg-input checked:bg-primary transition-colors duration-200 ease-in-out" thumbClass="size-3.5 rounded-full bg-background checked:translate-x-3 transition-transform duration-150 ease-in-out" />
    </ManagedControl>
  </View>;
}

// ---- editor pieces ----

export function FieldControl(props: { field: DriverField; config: unknown; disabled: boolean; onChange: (next: Record<string, unknown> | undefined) => void }) {
  const field = () => props.field;
  if (field().control === "select") {
    const options = () => field().options ?? [];
    const fallback = () => options()[0]?.value ?? "";
    const current = () => readConfigString(props.config, field().key) || fallback();
    return <SettingsSelect label={field().label} value={current()} options={options()} onChange={(next) => { if (!props.disabled) props.onChange(nextConfigWithField(props.config, field(), next === fallback() ? "" : next)); }} />;
  }
  if (field().control === "password") {
    const configured = () => secretConfigured(props.config, field().key);
    // ProviderSettingsForm.tsx: a SettingsSecretValue field is a SecretSourceInput (value or secret reference).
    const current = () => (props.config && typeof props.config === "object" ? (props.config as Record<string, unknown>)[field().key] : undefined);
    return <View class="flex-row items-center gap-2">
      <SecretSourceInput label={field().label} value={current()} sources={currentSecretSources} disabled={props.disabled} class="w-72"
        placeholder={configured() ? "Stored secret, enter a new value to replace" : field().placeholder ?? ""}
        onValueCommit={(next) => props.onChange(nextConfigWithField(props.config, field(), next))}
        onSecretChange={(secret) => props.onChange(secret ? { ...((props.config && typeof props.config === "object" ? props.config : {}) as Record<string, unknown>), [field().key]: secret } : nextConfigWithField(props.config, field(), ""))} />
      {configured() ? <IconButton label={`Clear ${field().label}`} icon="x" disabled={props.disabled} tone="destructive" onPress={() => props.onChange(nextConfigWithField(props.config, field(), ""))} /> : null}
    </View>;
  }
  return <DraftInput label={field().label} disabled={props.disabled} value={readConfigString(props.config, field().key)} placeholder={field().placeholder} class="w-72"
    onCommit={(next) => props.onChange(nextConfigWithField(props.config, field(), next))} />;
}

function EnvFieldRow(props: { managed?: string | undefined; divider: boolean; field: DriverEnvField; variable: EnvVar | undefined; disabled: boolean; onCommit: (value: string) => void; onSecret?: (secret: { provider: string; reference: string } | undefined) => void; onRemove: () => void }) {
  const redacted = () => props.variable?.valueRedacted === true;
  const value = () => redacted() || typeof props.variable?.value !== "string" ? "" : props.variable.value;
  return <Row divider={props.divider} title={props.field.label} description={props.field.description} managed={props.managed}
    control={<View class="flex-row items-center gap-2">
      {props.field.sensitive !== false
        ? <SecretSourceInput label={props.field.label} value={props.variable?.value} sources={currentSecretSources} disabled={props.disabled} class="w-56"
            placeholder={redacted() ? "Stored secret, enter a new value to replace" : props.field.placeholder ?? ""}
            onValueCommit={props.onCommit} onSecretChange={(secret) => (secret ? props.onSecret?.(secret) : props.onRemove())} />
        : <DraftInput label={props.field.label} disabled={props.disabled} value={value()}
            placeholder={props.field.placeholder ?? ""} class="w-56" onCommit={props.onCommit} />}
      {props.variable ? <IconButton label={`Clear ${props.field.label}`} icon="x" tone="destructive" disabled={props.disabled} onPress={props.onRemove} /> : null}
    </View>} />;
}

function configuredCommandArgs(config: unknown): string[] {
  const value = config !== null && typeof config === "object" ? (config as Record<string, unknown>).commandArgs : undefined;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
let argumentId = 0;
/** ProviderCommandArguments: a local ACP command's literal launch arguments, one per row. */
export function CommandArguments(props: { config: unknown; disabled: boolean; managed?: string | undefined; divider?: boolean; onChange: (next: Record<string, unknown>) => void }) {
  const seed = () => configuredCommandArgs(props.config).map((value) => ({ id: `arg-${argumentId++}`, value }));
  const rows = signal<{ id: string; value: string }[]>(seed());
  let published = JSON.stringify(configuredCommandArgs(props.config));
  effect(() => {
    const incoming = JSON.stringify(configuredCommandArgs(props.config));
    if (incoming === published) return;
    published = incoming;
    rows.set(seed());
  });
  function publish(next: { id: string; value: string }[]) {
    rows.set(next);
    const values = next.map((row) => row.value);
    published = JSON.stringify(values);
    props.onChange({ ...((props.config !== null && typeof props.config === "object" ? props.config : {}) as Record<string, unknown>), commandArgs: values });
  }
  return <Row divider={props.divider !== false} title="Arguments" description="One literal argument per row, in launch order." managed={props.managed}
    control={<PillButton label="Add argument" disabled={props.disabled} onPress={() => publish([...rows(), { id: `arg-${argumentId++}`, value: "" }])}><UiIcon name="plus" size={12} /><ButtonText>Add argument</ButtonText></PillButton>}>
    {rows().length > 0 ? <View class="mt-3 min-w-0 gap-2 pb-2">
      <Each of={rows()} key={(row) => row.id}>{(row, index) => props.managed !== undefined ? <Text class="truncate font-mono text-xs text-foreground">{row().value}</Text> : <View class="min-w-0 flex-row items-center gap-1.5">
        <DraftInput label={`Argument ${index() + 1}`} mono disabled={props.disabled} value={row().value} class="flex-1" onCommit={(next) => publish(rows().map((current) => current.id === row().id ? { ...current, value: next } : current))} />
        <IconButton label={`Remove argument ${index() + 1}`} icon="x" tone="destructive" disabled={props.disabled} onPress={() => publish(rows().filter((current) => current.id !== row().id))} />
      </View>}</Each>
    </View> : null}
  </Row>;
}

interface DraftRow { id: string; name: string; value: string; sensitive: boolean; valueRedacted?: boolean; secret?: unknown }
let draftId = 0;
function toDraftRows(environment: EnvVar[]): DraftRow[] {
  return environment.map((variable, index) => ({
    id: `${index}:${variable.name}`, name: variable.name, value: typeof variable.value === "string" ? variable.value : "", sensitive: variable.sensitive,
    ...(variable.valueRedacted !== undefined ? { valueRedacted: variable.valueRedacted } : {}), ...(typeof variable.value === "object" ? { secret: variable.value } : {}),
  }));
}

/** The Environment section's free-form variables: name, value, sensitive toggle, remove. */
function EnvironmentVariables(props: { environment: EnvVar[]; disabled: boolean; onChange: (next: EnvVar[]) => void; managed?: { names: ReadonlySet<string>; reason: string } | undefined }) {
  const rows = signal<DraftRow[]>(toDraftRows(props.environment));
  let seen = JSON.stringify(props.environment);
  let published: string | null = null;
  effect(() => {
    const incoming = JSON.stringify(props.environment);
    if (incoming === seen) return;
    seen = incoming;
    if (incoming === published) return;
    rows.set(toDraftRows(props.environment));
  });
  function publish(next: DraftRow[]) {
    const out: EnvVar[] = [];
    for (const row of next) {
      const name = row.name.trim();
      if (!ENV_NAME_PATTERN.test(name)) {
        if (name.length > 0 || row.value !== "" || row.sensitive !== true || row.valueRedacted !== undefined) return;
        continue;
      }
      out.push({ name, value: row.secret ?? row.value, sensitive: row.sensitive, ...(row.valueRedacted !== undefined ? { valueRedacted: row.valueRedacted } : {}) });
    }
    published = JSON.stringify(out);
    props.onChange(out);
  }
  function update(id: string, patch: Partial<DraftRow>) {
    // A row named like a pinned variable renders as the policy's, with no way to edit or remove it.
    if (patch.name !== undefined && props.managed?.names.has(patch.name)) return;
    const next = rows().map((row) => row.id === id ? { ...row, ...patch, ...(patch.value !== undefined ? { valueRedacted: false, secret: undefined } : {}) } : row);
    rows.set(next); publish(next);
  }
  function remove(id: string) { const next = rows().filter((row) => row.id !== id); rows.set(next); publish(next); }
  return <Row title="Variables" description="API keys, base URLs, and other per-instance CLI settings." divider={false}
    control={<PillButton label="Add variable" disabled={props.disabled} onPress={() => rows.set([...rows(), { id: `provider-env-${draftId++}`, name: "", value: "", sensitive: true }])}>
      <UiIcon name="plus" size={12} /><ButtonText>Add variable</ButtonText></PillButton>}>
    {rows().length > 0 ? <View class="mt-3 min-w-0 gap-2 pb-2">
      <Each of={rows()} key={(row) => row.id}>{(row, index) => props.managed?.names.has(row().name) ? <View class="min-w-0 flex-row flex-wrap items-center gap-1.5">
        <Text class="min-w-0 w-44 shrink-0 font-mono text-xs text-foreground truncate">{row().name}</Text>
        <Text class="text-xs text-muted-foreground">{props.managed.reason}</Text>
      </View> : <View class="min-w-0 gap-1.5 rounded-lg border border-border p-2">
        <View class="flex-row items-center gap-1.5">
          <DraftInput label={`Environment variable name ${index() + 1}`} mono disabled={props.disabled || row().valueRedacted === true} value={row().name} placeholder="VARIABLE_NAME" class="flex-1"
            onCommit={(name) => update(row().id, { name: name.trim() })} />
          <IconButton label={`Remove environment variable ${row().name || index() + 1}`} icon="x" tone="destructive" disabled={props.disabled} onPress={() => remove(row().id)} />
        </View>
        <View class="flex-row items-center gap-1.5">
          <DraftInput label={`Environment variable value ${index() + 1}`} mono masked={row().sensitive} disabled={props.disabled} value={row().valueRedacted ? "" : row().value}
            placeholder={row().valueRedacted ? "Stored secret, enter a new value to replace" : "value"} class="flex-1" onCommit={(value) => update(row().id, { value })} />
          {row().secret === undefined ? <IconButton label={`Mark environment variable ${row().name || index() + 1} as sensitive`} icon={row().sensitive ? "lock" : "lock-open"} disabled={props.disabled || row().valueRedacted === true}
            tooltip={row().sensitive ? "Sensitive, stored separately" : "Plain text"} onPress={() => update(row().id, { sensitive: !row().sensitive })} /> : null}
        </View>
      </View>}</Each>
      <Text class="text-xs text-muted-foreground">Sensitive values are stored separately and never returned to the app.{rows().some((row) => row.valueRedacted === true) ? " Enter a new value to rename a saved one or make it plain text." : ""}</Text>
    </View> : null}
  </Row>;
}

export function StatusLine(props: { live: ProviderView | undefined; enabled: boolean }) {
  const view = (): ProviderView | undefined => props.live ? { ...props.live, enabled: props.enabled } : undefined;
  const key = () => props.enabled ? statusKey(view()) : "disabled";
  const summary = () => props.enabled ? providerSummary(view()) : { headline: "Disabled", detail: null };
  const attention = () => key() === "warning" || key() === "error";
  const compat = () => props.enabled ? props.live?.compatibilityAdvisory : undefined;
  const hasCompat = () => compat() !== undefined && compat() !== null && compat()?.status !== "supported" && compat()?.status !== "unknown";
  const inline = () => hasCompat() ? (compat()?.status === "broken" ? "Incompatible" : compat()?.status === "unsupported" ? "Unsupported" : "Limited support") : summary().detail;
  const email = () => props.live?.auth.email;
  const authenticated = () => props.enabled && props.live?.auth.status === "authenticated";
  const authLabel = () => authenticated() ? props.live?.auth.label ?? props.live?.auth.type ?? null : null;
  return <View class="flex-row flex-wrap items-center gap-x-1.5">
    {attention() ? <View class="size-1.5 rounded-full" classList={{ [STATUS_DOT_CLASS[key()]]: true }} /> : null}
    {authenticated() && email()
      ? <>
        <Text class="text-xs text-muted-foreground">Authenticated as</Text>
        <ProviderAuthEmail email={email()} />
        {authLabel() ? <Text class="text-xs text-muted-foreground">{`· ${authLabel()}`}</Text> : null}
        {inline() ? <Text class="text-xs text-muted-foreground">{`· ${inline()}`}</Text> : null}
      </>
      : <>
        <Text class="text-xs text-muted-foreground">{summary().headline}</Text>
        {inline() ? <Text class="min-w-0 text-xs text-muted-foreground">{`· ${inline()}`}</Text> : null}
      </>}
  </View>;
}

export function ProviderEditor(props: CardCommon & { environmentLabel: string; saving: boolean; error: string | undefined; onUpdate: (next: InstanceConfig) => Promise<void>; onPatch: (patch: Parameters<ProviderApi["patch"]>[0]) => Promise<void>; onDelete?: () => Promise<void>; onReset?: () => Promise<void> }) {
  const meta = () => driverMeta(props.row.driver);
  const instance = () => instanceOf(props.row);
  const enabled = () => enabledOf(props.row, props.live);
  const name = () => nameOf(props.row, props.live);
  const accent = () => normalizeAccentColor(instance().accentColor);
  const disabled = () => props.readOnly;
  const confirmingDelete = signal(false);
  const confirmingReset = signal(false);
  // Resetting a default slot that is on by explicit setting but off by default turns it off too.
  const resetTurnsOff = () => enabled() && !resolveInstanceEnabled({ driver: props.row.driver });
  const fields = computed(() => { const m = meta(); return m ? deriveFields(m, instance().config) : []; });
  const envFields = () => meta()?.envFields ?? [];
  const envNames = () => new Set(envFields().map((field) => field.name));
  const genericEnv = () => envWithoutNames(instance().environment, envNames());
  const custom = computed(() => meta()?.driver === "antigravity" ? [] : readCustomModels((instance().config as Record<string, unknown> | undefined)?.customModels));
  const displayModels = computed(() => modelsForDisplay(props.live?.models, custom()));
  const prefs = () => props.api.modelPrefs()[props.row.instanceId];
  const favorites = () => props.api.favorites().filter((favorite) => favorite.provider === props.row.instanceId).map((favorite) => favorite.model);
  const ver = () => versionLabel(props.live?.version);
  const antigravity = () => props.row.driver === "antigravity";
  const codexManaged = () => props.row.driver === "codex" && readCodexSetupMode(instance().config) === "managed";
  // Only Antigravity (and Codex's managed mode, below) shows a runtime row; the other drivers just sign in.
  const showRuntime = () => antigravity() && !props.readOnly && props.live !== undefined && props.live.setup !== undefined;
  const showAuth = () => !props.readOnly && props.live !== undefined && (antigravity() || (!codexManaged() && (props.live.setup.canAuthenticate === true || (props.row.driver === "acpRegistry" && props.live.installed))));
  const showCursorNote = () => props.row.driver === "cursor" && props.live?.setup.canAuthenticate === false && !props.readOnly;
  const locks = () => managedInstanceLocks(props.api.managedPolicy(), props.row.driver);
  const lockedField = (key: string) => locks()?.configKeys.has(key) ? locks()?.reason : undefined;
  const showSetup = () => antigravity() || codexManaged() || showAuth() || showCursorNote() || envFields().length > 0;
  const setupRows = () => (antigravity() ? 1 : 0) + (codexManaged() ? 1 : 0) + (showRuntime() ? 1 : 0) + (showAuth() ? 1 : 0) + (showCursorNote() ? 1 : 0);

  const set = (next: InstanceConfig) => props.onUpdate(next);
  const withoutKey = (key: "displayName" | "accentColor" | "config" | "environment") => { const { [key]: _omit, ...rest } = instance(); return rest as InstanceConfig; };
  function updateDisplayName(value: string) {
    const trimmed = value.trim();
    void set(trimmed ? { ...withoutKey("displayName"), displayName: trimmed } : withoutKey("displayName"));
  }
  function updateAccent(value: string) {
    const normalized = normalizeAccentColor(value);
    void set(normalized ? { ...withoutKey("accentColor"), accentColor: normalized } : withoutKey("accentColor"));
  }
  function updateConfig(config: Record<string, unknown> | undefined) {
    void set(config !== undefined ? { ...withoutKey("config"), config } : withoutKey("config"));
  }
  function updateEnvironment(environment: EnvVar[]) {
    const cleaned = cleanEnvironment(environment);
    void set(cleaned.length > 0 ? { ...withoutKey("environment"), environment: cleaned } : withoutKey("environment"));
  }
  function updateCustomModels(next: CustomModel[]) {
    const config = { ...((instance().config as Record<string, unknown> | undefined) ?? {}), customModels: next.map(toCustomModelSetting) };
    void set({ ...withoutKey("config"), config });
  }
  const patch = (value: Parameters<ProviderApi["patch"]>[0]) => { void props.onPatch(value); };

  return <View class="gap-6 py-4" testID={`Provider details ${props.row.instanceId}`}>
    <Section flat title={name()} icon={<ProviderIconView driver={props.row.driver} instanceId={props.row.instanceId} name={name()} accentColor={instance().accentColor} badge={accent() !== undefined} />}
      action={<View class="flex-row items-center gap-1.5">
        {meta()?.badgeLabel ? <View class="rounded-full bg-warning-surface px-2 py-0.5"><Text class="text-2xs font-medium text-warning-foreground">{meta()?.badgeLabel}</Text></View> : null}
        {ver() ? <Text class="font-mono text-xs text-muted-foreground">{ver()}</Text> : null}
        <AdvisoryPopover api={props.api} row={props.row} live={props.live} readOnly={props.readOnly} updating={props.updating} onRunUpdate={props.onRunUpdate} size={16} />
        {props.onReset && props.row.isDirty ? <IconButton label={`Reset ${meta()?.label ?? props.row.driver} provider settings to default`} tooltip="Reset to default" icon="undo-2" size={12} disabled={disabled()} onPress={() => confirmingReset.set(true)} /> : null}
        {props.onDelete ? <IconButton label={`Delete instance ${props.row.instanceId}`} icon="trash-2" tone="destructive" disabled={disabled()} onPress={() => confirmingDelete.set(true)} /> : null}
      </View>}>
      {confirmingDelete() ? <ConfirmDialog testID="Confirm delete provider" message={`Remove the ${name()} provider instance?\nIts saved settings, including any custom binary path, will be removed.`}
        confirmLabel="Remove" cancelLabel="Keep provider" confirmAccessibilityLabel="Confirm delete provider" onClose={() => confirmingDelete.set(false)} onConfirm={() => { confirmingDelete.set(false); void props.onDelete?.(); }} /> : null}
      {confirmingReset() ? <ConfirmDialog testID="Confirm reset provider" message={`Reset the ${name()} provider to its defaults?${resetTurnsOff() ? "\nIt will also be turned off." : ""}\nIts saved settings, including any custom binary path, will be removed.`}
        confirmLabel="Reset" cancelLabel="Keep settings" confirmAccessibilityLabel="Confirm reset provider" onClose={() => confirmingReset.set(false)} onConfirm={() => { confirmingReset.set(false); void props.onReset?.(); }} /> : null}
      {props.readOnly ? <View class="border-b border-border-60 px-4 py-3"><Text class="text-xs text-muted-foreground">{props.live?.cached ? "Cached status from this device; connect the environment to see current details." : "Connect an environment to change this provider."}</Text></View> : null}
      <Row title="Status" divider={false} testID="Provider status" status={<View class="gap-1">
        <StatusLine live={props.live} enabled={enabled()} />
        {props.live?.auth.action && !props.readOnly ? <View class="max-w-xl gap-1.5 pt-1">
          <Text class="text-xs text-foreground">{props.live.auth.action.message}</Text>
          <Text class="font-mono text-2xs text-foreground">{props.live.auth.action.url}</Text>
          <PillButton label="Continue authentication" size="xs" onPress={() => {
            const action = props.live?.auth.action;
            if (!action) return;
            props.api.openExternal(action.url);
            // ProviderSettingsPanel.tsx:591-615 acceptUrlAuthentication.
            void props.api.acceptUrlAuth(props.row.instanceId, action.elicitationId).then((accepted) => {
              if (accepted === false) showToast({ type: "warning", title: "Authentication request expired", description: "Refresh the provider and start the authentication flow again." });
            }, (cause) => {
              showToast({ type: "error", title: "Could not continue authentication", description: cause instanceof Error && cause.message ? cause.message : "The authentication request expired." });
            });
          }}><UiIcon name="external-link" size={12} /><ButtonText>Continue authentication</ButtonText></PillButton>
        </View> : null}
      </View>} />
      <Row title="Display name" control={<View class="flex-row items-center gap-2">
        <AccentColorPicker name={name()} value={accent()} disabled={disabled()} onCommit={updateAccent} />
        <DraftInput label="Display name" disabled={disabled()} value={instance().displayName ?? ""} placeholder={meta()?.label ?? "Instance label"} class="w-56" onCommit={updateDisplayName} />
      </View>} />
      {props.error ? <View class="px-4 pb-3"><ErrorText>{props.error}</ErrorText></View> : props.saving ? <View class="px-4 pb-3"><Text class="text-xs text-muted-foreground">Saving...</Text></View> : null}
    </Section>

    {showSetup()
      ? <Section flat title="Setup">
        {antigravity() ? <Row divider={false} title="Environment" description="Device that runs this provider."
          control={<View class="min-w-0 items-end gap-2">
            <Text class="text-xs text-muted-foreground">{props.environmentLabel}</Text>
            {!enabled() && !props.readOnly ? <PillButton label="Enable Antigravity" onPress={() => void set({ ...instance(), enabled: true })}><ButtonText>Enable Antigravity</ButtonText></PillButton> : null}
          </View>} /> : null}
        {antigravity() && props.readOnly ? <Row title="Setup unavailable" description="Provider setup is read-only." /> : null}
        {antigravity() && !props.readOnly && props.live === undefined ? <Row title="Update required" description="Update this environment to manage Antigravity." /> : null}
        {codexManaged() ? <CodexManagedSetup divider={false} api={props.api} instanceId={props.row.instanceId} provider={props.live} enabled={enabled()} readOnly={props.readOnly}
          onModeChange={(mode) => void set({ ...instance(), enabled: true, config: { ...((instance().config as Record<string, unknown> | undefined) ?? {}), enabled: true, setupMode: mode } })} /> : null}
        {showRuntime() ? <ProviderRuntime divider={antigravity()} api={props.api} instanceId={props.row.instanceId} provider={props.live as ProviderView} label={meta()?.label ?? props.row.driver} environmentLabel={props.environmentLabel}
          binaryPath={readConfigString(instance().config, "binaryPath")} enabled={enabled()} readOnly={props.readOnly} /> : null}
        {showAuth() ? <ProviderAuthentication divider={showRuntime() || antigravity()} api={props.api} instanceId={props.row.instanceId} provider={props.live as ProviderView} environmentLabel={props.environmentLabel} readOnly={props.readOnly} /> : null}
        {showCursorNote() ? <Row divider={setupRows() > 1} title="Cursor account" description="Using CURSOR_API_KEY. Remove it from this provider's environment to use browser sign-in." /> : null}
        <Each of={envFields()} key={(field) => field.name}>{(field, index) => <EnvFieldRow divider={index() > 0 || setupRows() > 0} managed={locks()?.wholeEnvironment || locks()?.environmentNames.has(field().name) ? locks()?.reason : undefined} field={field()} variable={envVariable(instance().environment, field().name)} disabled={disabled()}
          onCommit={(value) => updateEnvironment(nextEnvWithFieldValue(instance().environment, field(), value))}
          onSecret={(secret) => { if (secret) updateEnvironment(nextEnvWithFieldSecret(instance().environment, field(), secret)); }}
          onRemove={() => updateEnvironment(envWithoutNames(instance().environment, new Set([field().name])))} />}</Each>
      </Section> : null}

    {!meta() ? <Section flat title="Runtime"><Row divider={false} title="Driver" description={`This instance uses ${props.row.driver}, which is not available in this build. Its configuration is preserved.`} /></Section> : null}
    {codexManaged() ? <FoldedSection title="Runtime"><CodexManagedRuntimeFields api={props.api} instanceId={props.row.instanceId} provider={props.live} /></FoldedSection>
      : fields().length > 0 ? <Section flat title="Runtime">
      <Each of={fields()} key={(field) => field.key}>{(field, index) => <Row title={field().label} description={field().description} divider={index() > 0} managed={lockedField(field().key)}
        control={<FieldControl field={field()} config={instance().config} disabled={disabled()} onChange={updateConfig} />} />}</Each>
      {props.row.driver === "acpRegistry" && readConfigString(instance().config, "source") === "local" ? <CommandArguments config={instance().config} disabled={disabled()} managed={lockedField("commandArgs")} onChange={(next) => updateConfig(next)} /> : null}
    </Section> : null}

    <Section flat title="Environment">
      {locks()?.wholeEnvironment ? <ManagedNotice>{locks()?.reason}</ManagedNotice> : null}
      <View class={locks()?.wholeEnvironment ? "opacity-50" : ""} style={{ pointerEvents: locks()?.wholeEnvironment ? "none" : "auto" }}>
      <EnvironmentVariables managed={locks() ? { names: locks()?.environmentNames as ReadonlySet<string>, reason: locks()?.reason as string } : undefined} environment={genericEnv()} disabled={disabled() || locks()?.wholeEnvironment === true} onChange={(next) => updateEnvironment([...(instance().environment ?? []).filter((variable) => envNames().has(variable.name)), ...next])} />
      </View>
    </Section>

    {props.live?.driver === "acpRegistry" ? <AcpSessionManagement api={props.api} instanceId={props.row.instanceId} provider={props.live} readOnly={props.readOnly} /> : null}

    {meta() ? <Section flat title="Models">
      <View class="gap-3 px-4 py-3">
        <Text class="text-xs text-muted-foreground">Model preferences and custom models are saved on the selected environment and shared across connected devices.</Text>
        <ProviderModels instanceId={props.row.instanceId} driver={props.row.driver} models={displayModels()} custom={custom()} hidden={prefs()?.hiddenModels ?? []} favorites={favorites()} order={prefs()?.modelOrder ?? []}
          supportsCustom={meta()?.supportsCustomModels ?? true} placeholder={meta()?.customModelPlaceholder ?? "model-slug"} canManageCustom={!props.readOnly} canWritePreferences={!props.readOnly}
          onCustomChange={updateCustomModels}
          onHiddenChange={(next, affected) => { const hidden = new Set(next); patch({ setModelsHidden: affected.map((model) => ({ provider: props.row.instanceId, model, hidden: hidden.has(model) })) }); }}
          onToggleFavorite={(model, favorite) => patch({ setModelFavorites: [{ provider: props.row.instanceId, model, favorite }] })}
          onFavoritesRemoved={(slugs) => patch({ setModelFavorites: slugs.map((model) => ({ provider: props.row.instanceId, model, favorite: false })) })}
          onOrderChange={(modelOrder) => patch({ setProviderModelOrder: { provider: props.row.instanceId, modelOrder } })} />
      </View>
    </Section> : null}
  </View>;
}

