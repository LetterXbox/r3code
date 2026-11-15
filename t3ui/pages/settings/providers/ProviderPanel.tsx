// ProviderSettingsPanel.tsx: the Providers page. A header with Add provider, Update all and
// refresh, then the provider list beside the selected provider's editor.
import { FadeScroll } from "../../../components/FadeScroll";
import { computed, effect, Scroll, signal, Text, View, windowSize } from "nsh";
import { showToast } from "../../../components/toast";
import { providerSelectionRequest, requestProviderSelection, type ProviderApi } from "./data";
import { DRIVERS } from "./driverMeta";
import {
  acpManagedAgentId, buildProviderInstanceOverridePatch, buildRows, projectProviderOverride, checkedParts, textGenerationPatchOnDisable, isUpdateActive, mergeLiveOnlyRows, updateCandidates, updateRunSummary, type InstanceConfig, type UpdateRun, type InstanceRow, type ProviderView,
} from "./logic";
import { AddProviderDialog } from "./AddProviderDialog";
import { DeviceTabs, PHASE_TITLE, showDeviceTabs } from "./DeviceTabs";
import { showTextGenerators } from "./policyLogic";
import { ProviderEditor, ProviderListRow, type ProjectOverride } from "./ProviderCard";
import { settingsWriteDenied } from "../settingsWriteAccess";
import { ProviderAdvancedSection, UsageProviders } from "./ProviderSections";
import { TextGenerators } from "./TextGeneratorsSection";
import { SearchAnchor } from "../SearchAnchor";
import { ButtonText, IconButton, PillButton, Row, Section, Tip, UiIcon } from "./ui";

const ORDER = DRIVERS.map((meta) => meta.driver);

/** ProviderSettingsPlaceholder: the Providers heading over a card holding an Empty state (icon, title, description). */
function ProviderPlaceholder(props: { title: string; description: string; detail?: string | null; testID?: string; tabs?: any; children?: any }) {
  return <Section title="Providers" plain>
    {props.tabs ?? null}
    <View testID={props.testID} style={{ height: providerCardHeight(windowSize().height) }} class="min-h-[512px] items-center justify-center overflow-hidden rounded-xl border border-border-60 bg-card-40">
      <View class="max-w-xl items-center gap-6 p-12">
        <View class="size-9 items-center justify-center rounded-md border border-border bg-card"><UiIcon name="server" size={18} tone="foreground" /></View>
        <View class="max-w-sm items-center gap-1">
          <Text class="text-center text-lg font-semibold text-foreground">{props.title}</Text>
          <Text class="text-center text-sm text-muted-foreground">{props.description}</Text>
        </View>
        {props.detail ? <Text class="w-full font-mono text-xs leading-relaxed text-muted-foreground">{props.detail}</Text> : null}
        {props.children ?? null}
      </View>
    </View>
  </Section>;
}

/** Rows for a cached snapshot: only what the cache holds, never settings that were not read. */
export function cachedRows(cached: ProviderView[]): InstanceRow[] {
  return cached.map((provider, index) => ({ provider, index })).sort((a, b) => {
    const left = ORDER.indexOf(a.provider.driver); const right = ORDER.indexOf(b.provider.driver);
    return (left < 0 ? ORDER.length : left) - (right < 0 ? ORDER.length : right) || a.index - b.index;
  }).map(({ provider }): InstanceRow => ({ instanceId: provider.instanceId, driver: provider.driver, explicit: undefined, isDefault: provider.instanceId === provider.driver, isDirty: false }));
}

/** The Checked label: the elapsed value in mono tabular-nums between "Checked" and its suffix, as the web's ProviderLastChecked. */
function CheckedLabel(props: { parts: { value: string; suffix: string } | null; cached: boolean }) {
  const parts = () => props.parts;
  return parts() === null ? "" : <>
    {"Checked "}{parts()?.suffix ? <Text class="font-mono tabular-nums">{parts()?.value}</Text> : parts()?.value}{parts()?.suffix ? ` ${parts()?.suffix}` : ""}{props.cached ? " (cached)" : ""}
  </>;
}

/** providerCardHeightClassName: min(44rem, 100dvh - 11rem), never below 32rem (rem = 16 points). */
export function providerCardHeight(windowHeight: number): number {
  return Math.max(512, Math.min(704, windowHeight - 176));
}

function errorText(cause: unknown, fallback: string): string { return cause instanceof Error && cause.message ? cause.message : fallback; }

export function ProviderPanel(props: { api: ProviderApi }) {
  const api = props.api;
  const selectedId = signal<string | null>(null);
  const deviceId = signal<string | null>(null);
  const adding = signal(false);
  const refreshing = signal(false);
  const updatingAll = signal(false);
  const pending = signal<string[]>([]);
  const saving = signal<string[]>([]);
  const updating = signal<string[]>([]);
  const errors = signal<Record<string, string>>({});

  const devices = () => api.devices?.() ?? [];
  const primaryDevice = () => devices().find((device) => device.primary);
  const activeDevice = () => devices().find((device) => device.id === deviceId()) ?? primaryDevice() ?? devices()[0];
  /** A saved environment other than the live connection: its providers are not held by this session. */
  const remoteDevice = () => { const device = activeDevice(); return device && !device.primary ? device : null; };
  /** A device tab that has since gone (removed or unpaired): the web's "Device unavailable" placeholder until another is picked. */
  const missingDevice = () => deviceId() !== null && devices().length > 0 && !devices().some((device) => device.id === deviceId());
  /** environmentAccess "loading" for permissions: the grant read has not answered yet. */
  const checkingAccess = () => live() && api.canManage !== undefined && api.canManage() === null;
  const tabs = () => showDeviceTabs(devices()) ? <DeviceTabs devices={devices()} selectedId={activeDevice()?.id ?? ""} onSelect={(id) => deviceId.set(id)} /> : null;
  /** classifyProviderEnvironmentAccess "read-only": the session lacks providers:manage. */
  const limited = () => api.canManage?.() === false;
  const live = () => api.live();
  const connected = () => api.status() === "connected";
  const showCache = () => !connected() && api.cachedLoaded() && api.cached().length > 0;
  /** What the list shows: the live snapshot when connected, the on-disk cache otherwise. */
  const providers = computed<ProviderView[]>(() => live() ? api.providers() : showCache() ? api.cached() : []);
  const rows = computed<InstanceRow[]>(() => live() ? buildRows(api.instances() as Record<string, InstanceConfig>, api.providers()) : showCache() ? mergeLiveOnlyRows(cachedRows(api.cached()), api.cached()) : []);
  // Opened from the model picker's "Open provider setup": that provider is selected once its row exists.
  effect(() => { const wanted = providerSelectionRequest(); if (wanted !== null && rows().some((row) => row.instanceId === wanted)) { selectedId.set(wanted); requestProviderSelection(null); } });
  // targetInstanceMissing: the requested instance is not on this device, so nothing is selected in its place.
  const targetMissing = () => live() && selectedId() === null && providerSelectionRequest() !== null && !rows().some((row) => row.instanceId === providerSelectionRequest());
  const selected = computed(() => rows().find((row) => row.instanceId === selectedId()) ?? (targetMissing() ? null : rows()[0] ?? null));
  const liveFor = (row: InstanceRow) => providers().find((provider) => provider.instanceId === row.instanceId);
  const candidates = computed(() => live() ? updateCandidates(providers()) : []);
  const checked = computed(() => checkedParts(providers()));
  // As the web dialog: configured instances plus the two default slots that run before configuration.
  const existingIds = computed(() => new Set<string>(Object.keys(api.instances())));

  // ProviderSettingsPanel: with a project selected (and a server that honours providerInstances overrides) the list's
  // switches edit that project's enablement instead of the device's.
  const projectOverrideFor = (row: InstanceRow): ProjectOverride | undefined => {
    const projectId = live() ? api.projectScope?.() ?? null : null;
    if (projectId === null) return undefined;
    const write = (value: boolean | undefined) => void api.updateSettings({ projectSettingsOverrides: buildProviderInstanceOverridePatch(api.settings(), [projectId], row.instanceId, value) })
      .catch((cause) => showToast({ type: "error", title: "Could not update provider instance", description: errorText(cause, "The settings update failed.") }));
    return { value: projectProviderOverride(api.settings(), projectId, row.instanceId), onChange: (next) => write(next), onReset: () => write(undefined) };
  };
  const setError = (id: string, message: string | null) => errors.update((all) => {
    const copy = { ...all };
    if (message === null) delete copy[id]; else copy[id] = message;
    return copy;
  });
  const track = (list: { update: (fn: (ids: string[]) => string[]) => void }, id: string, on: boolean) => list.update((ids) => on ? [...ids, id] : ids.filter((item) => item !== id));

  async function persist(row: InstanceRow, next: InstanceConfig): Promise<void> {
    if (!live()) return;
    setError(row.instanceId, null); track(saving, row.instanceId, true);
    try { await api.mutate({ operation: "upsert", instanceId: row.instanceId, instance: next }, textGenerationPatchOnDisable(api.settings(), row.instanceId, row.explicit ?? { driver: row.driver }, next)); }
    catch (cause) { showToast({ type: "error", title: "Could not update provider instance", description: errorText(cause, "The settings update failed.") }); }
    finally { track(saving, row.instanceId, false); }
  }
  async function toggle(row: InstanceRow, enabled: boolean): Promise<void> {
    if (!live() || pending().includes(row.instanceId)) return;
    track(pending, row.instanceId, true);
    const base = row.explicit ?? { driver: row.driver };
    const config = base.config !== null && typeof base.config === "object" ? { ...(base.config as Record<string, unknown>) } : undefined;
    try {
      setError(row.instanceId, null);
      const next: InstanceConfig = { ...base, enabled, ...(config && "enabled" in config ? { config: { ...config, enabled } } : {}) };
      await api.mutate({ operation: "upsert", instanceId: row.instanceId, instance: next }, textGenerationPatchOnDisable(api.settings(), row.instanceId, base, next));
    } catch (cause) { showToast({ type: "error", title: "Could not update provider instance", description: errorText(cause, "The settings update failed.") }); }
    finally { track(pending, row.instanceId, false); }
  }
  async function remove(row: InstanceRow): Promise<void> {
    if (!live()) return;
    setError(row.instanceId, null);
    const removed = row.explicit ?? { driver: row.driver };
    try { await api.mutate({ operation: "remove", instanceId: row.instanceId }); if (selectedId() === row.instanceId) selectedId.set(null); }
    catch (cause) { showToast({ type: "error", title: row.isDefault ? "Could not reset provider instance" : "Could not delete provider instance", description: errorText(cause, "The settings update failed.") }); return; }
    // Concurrent removals race client snapshots; the server decides whether the managed agent is still in use.
    const agentId = row.isDefault ? null : acpManagedAgentId(removed);
    if (agentId !== null && api.uninstallAcpManagedBinary) {
      try { await api.uninstallAcpManagedBinary(agentId); }
      catch (cause) { showToast({ type: "warning", title: "Provider deleted, but managed files remain", description: errorText(cause, "Managed binary cleanup failed.") }); }
    }
  }
  async function patch(row: InstanceRow, value: Parameters<ProviderApi["patch"]>[0]): Promise<void> {
    if (!live()) return;
    setError(row.instanceId, null);
    try { await api.patch(value); }
    catch (cause) { setError(row.instanceId, errorText(cause, "Could not save the model preferences.")); }
  }
  /** Starts one provider update and reports how it ended, as the web's useProviderUpdates does. */
  async function dispatchUpdate(row: InstanceRow, targetVersion?: string): Promise<(UpdateRun["outcome"] & { thrown?: boolean }) | null> {
    if (!live() || updating().includes(row.instanceId)) return null;
    track(updating, row.instanceId, true); setError(row.instanceId, null);
    try {
      const state = await api.updateProvider({ driver: row.driver, instanceId: row.instanceId, ...(targetVersion ? { targetVersion } : {}) });
      return { kind: "result", failure: state?.status === "succeeded" ? null : state?.message ?? "Provider update did not finish." };
    } catch (cause) { return { kind: "result", thrown: true, failure: errorText(cause, "The provider update command could not be started.") }; }
    finally { track(updating, row.instanceId, false); }
  }
  const nameOfDriver = (driver: string) => DRIVERS.find((meta) => meta.driver === driver)?.label ?? driver;
  /** The row's Update now and Install buttons: only a failure to start is reported. */
  async function runUpdate(row: InstanceRow, targetVersion?: string): Promise<void> {
    const outcome = await dispatchUpdate(row, targetVersion);
    // ProviderSettingsPanel.tsx runProviderUpdate: only a rejected RPC toasts; a failed or unchanged update shows in the row's popover.
    if (outcome?.kind === "result" && outcome.thrown === true && outcome.failure !== null && !isUpdateActive(liveFor(row)))
      showToast({ type: "error", title: `Could not update ${nameOfDriver(row.driver)}`, description: outcome.failure });
  }
  async function updateAll(): Promise<void> {
    if (updatingAll() || !live()) return;
    updatingAll.set(true);
    const runs: UpdateRun[] = (await Promise.all(candidates().map(async (provider): Promise<UpdateRun | null> => {
      const row: InstanceRow = { instanceId: provider.instanceId, driver: provider.driver, explicit: undefined, isDefault: false, isDirty: false };
      const outcome = await dispatchUpdate(row);
      return outcome ? { machineLabel: api.environmentLabel(), driver: provider.driver, instanceId: provider.instanceId, outcome } : null;
    }))).filter((run): run is UpdateRun => run !== null);
    const summary = updateRunSummary(runs, nameOfDriver);
    if (summary) showToast(summary);
    updatingAll.set(false);
  }
  async function refresh(): Promise<void> {
    if (refreshing() || !live()) return;
    refreshing.set(true);
    // The web only logs a failed refresh; the status label keeps showing the last check.
    try { await api.refresh(); } catch { /* logged on the web */ }
    finally { refreshing.set(false); }
  }

  const isUpdating = (row: InstanceRow) => updating().includes(row.instanceId) || isUpdateActive(liveFor(row));

  return <View class="gap-8" testID="Provider settings">
    {api.status() === "connecting" && !showCache() ? <ProviderPlaceholder tabs={tabs()} title="Loading provider settings" description={`Waiting for ${api.environmentLabel()}'s configuration.`} /> : null}
    {(api.status() === "disconnected" || api.status() === "error") && showCache() ? <View testID="Providers disconnected" class="items-start gap-2 px-4">
      <Text class="text-sm text-muted-foreground">{api.status() === "error" ? "Could not connect to the environment." : "Connect an environment to change provider settings."}</Text>
      {api.error() ? <Text class="text-xs text-destructive-foreground">{api.error()}</Text> : null}
      <PillButton label="Connect providers environment" size="xs" onPress={() => api.openConnections()}><ButtonText>Connect environment</ButtonText></PillButton>
    </View> : null}
    {(api.status() === "disconnected" || api.status() === "error") && !showCache() && api.cachedLoaded() ? <ProviderPlaceholder tabs={tabs()} testID="Providers disconnected"
      title={api.status() === "error" ? "Could not connect to this device" : "No connected devices"}
      description={api.status() === "error" ? "Failed to connect." : "Connect an execution environment before configuring providers."}
      detail={api.error()}>
      <PillButton label="Connect providers environment" size="xs" onPress={() => api.openConnections()}><ButtonText>Connect environment</ButtonText></PillButton>
    </ProviderPlaceholder> : null}
    {connected() && !live() ? <Text class="px-4 text-sm text-muted-foreground">Loading providers...</Text> : null}
    {!connected() && !api.cachedLoaded() ? <Text class="px-4 text-sm text-muted-foreground">Loading local provider cache...</Text> : null}
    {showCache() ? <View testID="Cached provider status" class="gap-1 rounded-lg border border-border-60 bg-card-40 px-4 py-3">
      <Text class="text-sm font-medium text-foreground">Cached local provider status</Text>
      <Text class="text-xs text-muted-foreground">Not connected. Installation, authentication and availability may have changed since this cache was saved.</Text>
    </View> : null}

    {missingDevice() ? <ProviderPlaceholder tabs={tabs()} testID="Provider device placeholder" title="Device unavailable" description="Reconnect this device to set up its provider, or select another device." /> : null}
    {!missingDevice() && !remoteDevice() && checkingAccess() ? <ProviderPlaceholder tabs={tabs()} testID="Provider access placeholder" title="Loading provider settings" description="Checking what this session is allowed to change." /> : null}
    {!missingDevice() && remoteDevice() ? <ProviderPlaceholder tabs={tabs()} testID="Provider device placeholder"
      title={remoteDevice()?.phase === "checking" ? "Loading provider settings" : remoteDevice()?.phase === "failed" ? "Could not connect to this device" : "Provider settings are unavailable"}
      description={remoteDevice()?.phase === "checking" ? `Waiting for ${remoteDevice()?.label}'s configuration.` : PHASE_TITLE[remoteDevice()?.phase ?? "off"]}
      detail={remoteDevice()?.phase === "failed" ? remoteDevice()?.error ?? null : null} /> : null}
    {!missingDevice() && !remoteDevice() && !checkingAccess() && (live() || showCache()) ? <Section title="Providers" plain
      titleAction={live() && !limited() ? <IconButton label="Add provider from heading" tooltip="Add provider" icon="plus" onPress={() => adding.set(true)} /> : null}
      action={<View class="flex-row items-center gap-2">
        {candidates().length > 0 || updatingAll() ? <PillButton label="Update all providers" size="xs" variant="ghost" disabled={updatingAll()} onPress={() => void updateAll()} tooltip={<Tip><View>
          <Text class="text-xs text-popover-foreground">{`${api.environmentLabel()}: ${candidates().map((candidate) => nameOfDriver(candidate.driver)).join(", ")}`}</Text></View></Tip>}>
          <ButtonText tone="muted">{updatingAll() ? "Updating…" : "Update all"}</ButtonText></PillButton> : null}
        <PillButton label="Refresh provider status" size="xs" variant="ghost" tooltip="Refresh provider status" disabled={!live() || refreshing()} onPress={() => void refresh()}>
          <UiIcon name="refresh-cw" size={12} /><Text class="text-xs text-muted-foreground">{refreshing() ? "Refreshing providers" : <CheckedLabel parts={checked()} cached={!live()} />}</Text></PillButton>
      </View>}>
      {tabs()}
      {limited() ? <View testID="Limited permissions" class="overflow-hidden rounded-xl border border-border-60 bg-card-40">
        <Row divider={false} title="Limited permissions" description={`This session can view ${api.environmentLabel()}'s providers but can't change their settings.`} />
      </View> : null}
      <View class="flex-row overflow-hidden rounded-xl border border-border-60 bg-card-40" style={{ height: providerCardHeight(windowSize().height) }}>
        <View class="w-[272px] border-r border-border-60 bg-muted-10">
          <FadeScroll surface="muted-10" class="flex-1">
            <View>
              <Each of={rows()} key={(row) => row.instanceId}>{(row) => <ProviderListRow api={api} row={row()} live={liveFor(row())} readOnly={!live() || limited()} updating={isUpdating(row())} onRunUpdate={(version) => void runUpdate(row(), version)} selected={selected()?.instanceId === row().instanceId} error={errors()[row().instanceId]}
                pending={pending().includes(row().instanceId)} projectOverride={projectOverrideFor(row())} canWriteSettings={!settingsWriteDenied()} onSelect={() => { requestProviderSelection(null); selectedId.set(row().instanceId); }} onToggle={(enabled) => void toggle(row(), enabled)} />}</Each>
              {live() && !limited() ? <View accessibilityLabel="Add provider" role="button" onPress={() => adding.set(true)} class="flex-row items-center gap-3 px-4 py-3 hover:bg-provider-row-hover transition-colors duration-150 ease-in-out">
                <UiIcon name="plus" size={16} /><Text class="text-sm text-muted-foreground">Add provider</Text></View> : null}
            </View>
          </FadeScroll>
        </View>
        <View class="min-w-0 flex-1">
          {selected() ? <Scroll class="flex-1" contentClass="px-0">
            <Each of={selected() ? [selected() as InstanceRow] : []} key={(row) => row.instanceId}>{(row) =>
              <ProviderEditor api={api} row={row()} live={liveFor(row())} readOnly={!live() || limited()} updating={isUpdating(row())} onRunUpdate={(version) => void runUpdate(row(), version)} environmentLabel={api.environmentLabel()} saving={saving().includes(row().instanceId)} error={errors()[row().instanceId]}
                onUpdate={(next) => persist(row(), next)} onPatch={(value) => patch(row(), value)}
                onDelete={!row().isDefault ? () => remove(row()) : undefined} onReset={row().isDefault ? () => remove(row()) : undefined} />}</Each>
          </Scroll> : <Text class="p-6 text-sm text-muted-foreground">{targetMissing() ? "This provider instance is no longer available on this device." : live() ? "No providers configured." : "No providers were found in the local cache."}</Text>}
        </View>
      </View>
    </Section> : null}
    {live() && !remoteDevice() && !missingDevice() && !checkingAccess() ? <SearchAnchor path="/settings/providers" id="usage-providers"><UsageProviders api={api} environmentLabel={api.environmentLabel()} readOnly={limited()} /></SearchAnchor> : null}
    {live() && !remoteDevice() && !missingDevice() && !checkingAccess() && showTextGenerators(api.managedPolicy()) ? <SearchAnchor path="/settings/providers" id="text-generators"><TextGenerators api={api} environmentLabel={api.environmentLabel()} readOnly={limited()} /></SearchAnchor> : null}
    {live() && !remoteDevice() && !missingDevice() && !checkingAccess() ? <ProviderAdvancedSection api={api} readOnly={limited()} /> : null}
    {adding() && live() && !limited() ? <AddProviderDialog api={api} environmentLabel={api.environmentLabel()} existingIds={existingIds()} onClose={() => adding.set(false)} onCreated={(id) => selectedId.set(id)} /> : null}
  </View>;
}

