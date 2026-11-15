// client-runtime state/sharedSettings.ts + useSettings.ts useUpdateSettingsTarget: a few server settings are shared,
// so a change saved on the selected environment is also written to every other connected environment whose config
// has loaded (supportsSharedSettingsSync), filtered per target (filterSharedServerPatch). Failures name the machine.
import { showToast } from "../components/toast/toastState";
import { record } from "../backend/client";
import { environmentConfigs, environmentConnections, managedEnvironment, managedEnvironmentIds, requestEnvironment } from "./connectionManager";

export const SHARED_SERVER_SETTING_KEYS = [
  "continueThreadsAfterServerUpdate", "sidebarAutoSettleAfterDays", "sidebarAutoSettleOnMerge", "autoResumeLimitedThreads",
  "snoozeLimitedThreads", "snoozePresets", "newWorktreesStartFromOrigin", "sourceControlWritingStyle", "textGenerationModelSelection",
] as const;
const SHARED = new Set<string>(SHARED_SERVER_SETTING_KEYS);

type Patch = Record<string, unknown>;
export function splitSharedServerPatch(patch: Patch): { sharedPatch: Patch; localPatch: Patch } {
  const sharedPatch: Patch = {};
  const localPatch: Patch = {};
  for (const [key, value] of Object.entries(patch)) (SHARED.has(key) ? sharedPatch : localPatch)[key] = value;
  return { sharedPatch, localPatch };
}

const driverOf = (settings: Patch | null | undefined, instanceId: string) => {
  const instance = record(record(settings?.providerInstances)?.[instanceId]);
  return typeof instance?.driver === "string" ? instance.driver : instanceId;
};
const instanceEnabled = (settings: Patch, instanceId: string) => record(record(settings.providerInstances)?.[instanceId])?.enabled !== false;

export function filterSharedServerPatch(patch: Patch, settings?: Patch | null, sourceSettings: Patch | null | undefined = settings, targetIsSource = false): Patch {
  const selection = record(patch.textGenerationModelSelection);
  const instanceId = typeof selection?.instanceId === "string" ? selection.instanceId : (record(sourceSettings?.textGenerationModelSelection)?.instanceId as string | undefined);
  let next = patch;
  if (!targetIsSource && selection && (!settings || (instanceId !== undefined && (driverOf(sourceSettings, instanceId) !== driverOf(settings, instanceId) || !instanceEnabled(settings, instanceId))))) {
    const { textGenerationModelSelection: _dropped, ...rest } = next;
    next = rest;
  }
  if (settings) return next;
  const { continueThreadsAfterServerUpdate: _gone, ...rest } = next;
  return rest;
}

/** The connected saved environments with a loaded config (supportsSharedSettingsSync). */
export function sharedSettingsSyncTargets(): string[] {
  return managedEnvironmentIds().filter((id) => environmentConnections()[id]?.phase === "connected" && environmentConfigs()[id] !== undefined);
}

/** After the selected environment took `patch`, writes its shared part to the other connected environments. */
export async function syncSharedSettings(patch: Patch, sourceSettings: Patch | null, request = requestEnvironment): Promise<void> {
  const { sharedPatch } = splitSharedServerPatch(patch);
  if (Object.keys(sharedPatch).length === 0) return;
  const writes = sharedSettingsSyncTargets().flatMap((id) => {
    const targetPatch = filterSharedServerPatch(sharedPatch, record(environmentConfigs()[id]?.settings), sourceSettings, false);
    return Object.keys(targetPatch).length === 0 ? [] : [{ id, label: managedEnvironment(id)?.label ?? id, patch: targetPatch }];
  });
  const outcomes = await Promise.all(writes.map(async (write) => {
    try { await request(write.id, "server.updateSettings", { patch: write.patch }); return { label: write.label, error: null as string | null }; }
    catch (cause) { return { label: write.label, error: cause instanceof Error ? cause.message : "The save failed. Try reconnecting and saving again." }; }
  }));
  const failures = outcomes.filter((outcome) => outcome.error !== null).map((outcome) => `Could not save on ${outcome.label}: ${outcome.error}`);
  if (failures.length === 0) return;
  // The selected environment already saved it, so a failure elsewhere is always a partial save.
  showToast({ type: "error", title: "Setting saved on some environments", description: failures.join("\n") });
}
