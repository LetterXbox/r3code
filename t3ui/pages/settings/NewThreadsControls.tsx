// ProjectDefaultsSettings.tsx, category "general": the "New threads" card of the Threads page. Model, Fallback
// model, Permissions and Workspace follow the settings scope: on the environment they write the server's defaults,
// for one project they write that project's override.
import { Text, View } from "nsh";
import { SettingsSelect } from "../../components/SettingsLayout";
import { runtimeModeConfig } from "../../components/composer/runtimeModeConfig";
import { availableModels, rawProviderRecords } from "../../store";
import type { RuntimeMode } from "../../store";
import { ModelPickerButton } from "./ModelSelectionControl";
import { readSelection, type ModelSelectionValue } from "./providers/textGenerators";
import { isProjectScope, readScoped, scopeProjectId, writeScoped } from "./scopeState";
import { readSetting } from "./settingsSync";
import { ModelTraitsControl, readSelectionWithOptions, type SelectionWithOptions } from "./ModelTraitsControl";
import { serverManagedPolicy, serverSettings } from "./settingsState";
import { managedRuntimeModeDenial } from "./managedPolicyLocks";

const RUNTIME_ORDER: RuntimeMode[] = ["approval-required", "auto-accept-edits", "auto", "full-access"];
/** DEFAULT_RUNTIME_MODE (contracts). */
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
/** resolveEnvModeLabel (BranchToolbar.logic.ts). */
export const ENV_MODE_LABELS = { local: "Current checkout", worktree: "New worktree" } as const;

const storedModel = () => readSelection(readScoped("defaultModelSelection", "server"));
const storedModelWithOptions = () => readSelectionWithOptions(readScoped("defaultModelSelection", "server"));
const storedFallback = () => readSelection(readSetting("fallbackModelSelection", "server"));
const storedFallbackWithOptions = () => readSelectionWithOptions(readSetting("fallbackModelSelection", "server"));

type ProviderRecord = Record<string, unknown>;
interface InstanceEntry { instanceId: string; driverKind: string; enabled: boolean; isAvailable: boolean; status: string; isDefault: boolean; models: { slug: string; isDefault: boolean; isCustom: boolean }[] }

/** deriveProviderInstanceEntries + sortProviderInstanceEntries (providerInstances.ts): driver groups in first-seen order,
 * each group's default instance (instance id = driver) before its custom ones. applyProviderInstanceSettings: a
 * project's projectSettingsOverrides[projectId].providerInstances[instanceId].enabled wins over the machine's. */
export function providerInstanceEntries(records: readonly ProviderRecord[], settings?: unknown, projectId?: string | null): InstanceEntry[] {
  const overrideFor = (instanceId: string): boolean | undefined => {
    if (!projectId) return undefined;
    const pick = (value: unknown, key: string) => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined);
    const enabled = pick(pick(pick(pick(pick(settings, "projectSettingsOverrides"), projectId), "providerInstances"), instanceId), "enabled");
    return typeof enabled === "boolean" ? enabled : undefined;
  };
  const entries: InstanceEntry[] = records.flatMap((record) => {
    if (typeof record.instanceId !== "string" || typeof record.driver !== "string") return [];
    const models = Array.isArray(record.models) ? record.models.flatMap((item) => {
      const model = typeof item === "object" && item !== null ? (item as ProviderRecord) : null;
      return model && typeof model.slug === "string" ? [{ slug: model.slug, isDefault: model.isDefault === true, isCustom: model.isCustom === true }] : [];
    }) : [];
    return [{ instanceId: record.instanceId, driverKind: record.driver, enabled: overrideFor(record.instanceId) ?? record.enabled !== false, isAvailable: record.availability !== "unavailable", status: typeof record.status === "string" ? record.status : "", isDefault: record.instanceId === record.driver, models }];
  });
  const byKind = new Map<string, InstanceEntry[]>();
  for (const entry of entries) { const bucket = byKind.get(entry.driverKind); if (bucket) bucket.push(entry); else byKind.set(entry.driverKind, [entry]); }
  return [...byKind.values()].flatMap((bucket) => [...bucket.filter((entry) => entry.isDefault), ...bucket.filter((entry) => !entry.isDefault)]);
}

const selectable = (entry: InstanceEntry) => entry.enabled && entry.isAvailable;
/** resolveSelectableProviderInstanceEntry with no requested instance. */
const firstSelectable = (entries: readonly InstanceEntry[]) =>
  entries.find((entry) => selectable(entry) && entry.status === "ready") ?? entries.find((entry) => selectable(entry) && entry.status !== "error");

/** resolveProjectDefaultProviderModelSelection: the first driver group wins, then that instance's default model
 * (getDefaultProviderInstanceModel: the default non-custom model, else the first non-custom, else the first). */
export function resolveAutomaticModel(records: readonly ProviderRecord[], settings?: unknown, projectId?: string | null): ModelSelectionValue | null {
  const entries = providerInstanceEntries(records, settings, projectId);
  const entry = firstSelectable(entries.filter((candidate) => candidate.driverKind === entries[0]?.driverKind)) ?? firstSelectable(entries);
  if (!entry) return null;
  const model = entry.models.find((item) => item.isDefault && !item.isCustom)?.slug ?? entry.models.find((item) => !item.isCustom)?.slug ?? entry.models[0]?.slug;
  return model ? { instanceId: entry.instanceId, model } : null;
}

/** The model new threads use while none is set (resolveProjectDefaultProviderModelSelection). */
export function automaticModel(): ModelSelectionValue | null {
  return resolveAutomaticModel(rawProviderRecords(), serverSettings(), scopeProjectId());
}

export const defaultModelDescription = () =>
  isProjectScope()
    ? "Model for new threads in this project."
    : storedModel() === null && automaticModel() !== null
      ? "Default model for new threads, selected automatically. Projects can override it."
      : "Default model for new threads. Projects can override it.";

export const permissionsDescription = () =>
  isProjectScope() ? "Permissions for new threads in this project." : "Default permissions for new threads. Projects can override them.";

export const workspaceDescription = () =>
  isProjectScope() ? "Where new threads in this project start." : "Where new threads start. Projects and their t3.json can override it.";

export const FALLBACK_DESCRIPTION = "Used for new threads when the default model's provider is out of usage.";

export function DefaultModelControl() {
  const shown = () => storedModel() ?? automaticModel();
  return (
    <View class="min-w-0 flex-row flex-wrap items-center justify-end gap-1.5">
      {availableModels().length === 0 && !storedModel() ? (
        <Text class="text-sm text-muted-foreground">No providers available</Text>
      ) : (
        <ModelPickerButton label="Default" selection={shown} onSelect={(selection) => void writeScoped("defaultModelSelection", "server", selection as never)} />
      )}
      <ModelTraitsControl label="Default model" selection={() => storedModelWithOptions() ?? (shown() as SelectionWithOptions | null)} onChange={(next) => void writeScoped("defaultModelSelection", "server", next as never)} />
    </View>
  );
}

export function FallbackModelControl() {
  return availableModels().length === 0 && !storedFallback() ? (
    <Text class="text-sm text-muted-foreground">No providers available</Text>
  ) : (
    <View class="min-w-0 flex-row flex-wrap items-center justify-end gap-1.5">
      <ModelPickerButton label="Fallback" emptyLabel="None" selection={storedFallback} onSelect={(selection) => void writeScoped("fallbackModelSelection", "server", selection as never)} />
      {storedFallback() !== null ? <ModelTraitsControl label="Fallback model" selection={storedFallbackWithOptions} onChange={(next) => void writeScoped("fallbackModelSelection", "server", next as never)} /> : null}
    </View>
  );
}

export const permissionsValue = (): RuntimeMode => {
  const value = readScoped("defaultRuntimeMode", "server");
  return typeof value === "string" && value in runtimeModeConfig ? (value as RuntimeMode) : DEFAULT_RUNTIME_MODE;
};

export function PermissionsControl() {
  return (
    <SettingsSelect
      label="Default permissions"
      value={permissionsValue()}
      triggerIcon={runtimeModeConfig[permissionsValue()].icon}
      options={RUNTIME_ORDER.map((mode) => { const denied = managedRuntimeModeDenial(serverManagedPolicy(), mode); return { value: mode, label: runtimeModeConfig[mode].label, description: denied ?? runtimeModeConfig[mode].description, icon: runtimeModeConfig[mode].icon, ...(denied ? { disabled: true } : {}) }; })}
      onChange={(next) => void writeScoped("defaultRuntimeMode", "server", next)}
    />
  );
}

export const workspaceValue = (): "local" | "worktree" => (readScoped("defaultThreadEnvMode", "server") === "worktree" ? "worktree" : "local");

export function WorkspaceControl() {
  return (
    <SettingsSelect
      label="Default workspace"
      value={workspaceValue()}
      options={[{ value: "local", label: ENV_MODE_LABELS.local }, { value: "worktree", label: ENV_MODE_LABELS.worktree }]}
      onChange={(next) => void writeScoped("defaultThreadEnvMode", "server", next)}
    />
  );
}

/** What each row's reset mark does outside a project scope (the web's `resetAction`s). */
export const NEW_THREADS_RESETS = {
  "default-model": { keys: ["defaultModelSelection"], differs: () => readSetting("defaultModelSelection", "server") != null, reset: () => void writeScoped("defaultModelSelection", "server", null) },
  "fallback-model": { keys: ["fallbackModelSelection"], differs: () => storedFallback() !== null, reset: () => void writeScoped("fallbackModelSelection", "server", null) },
  "default-permissions": { keys: ["defaultRuntimeMode"], differs: () => (readSetting("defaultRuntimeMode", "server") ?? DEFAULT_RUNTIME_MODE) !== DEFAULT_RUNTIME_MODE, reset: () => void writeScoped("defaultRuntimeMode", "server", DEFAULT_RUNTIME_MODE) },
  "new-threads": { keys: ["defaultThreadEnvMode"], differs: () => readSetting("defaultThreadEnvMode", "server") != null, reset: () => void writeScoped("defaultThreadEnvMode", "server", null) },
};
