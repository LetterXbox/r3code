// What the composer reads from the server's provider snapshots (`server.getConfig` providers):
// each instance's driver and accent, and the selected model's option descriptors, slash
// commands and skills. All values are the server's own; nothing here is invented.
import { computed } from "nsh";
import { availableModels, modelOptionsFor, rawProviderRecords, selectedModel } from "../../store";
import type { AvailableModel } from "../../store";
import { descriptorsWithSelections, parseDescriptors, unavailableModelOptionDescriptors, withoutPlanAgentOption } from "./modelTraits";
import type { Descriptor } from "./modelTraits";
import { parseUsageLimits } from "./usageLimitsLogic";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

export interface ProviderMeta { instanceId: string; driver: string; displayName: string; accentColor: string | null }

export interface ProviderCommand { name: string; description: string | null; inputHint: string | null }
export interface ProviderSkill {
  name: string; displayName: string | null; description: string | null; path: string; scope: string | null;
  /** Set (to the full `description`, or null) when `description` shows a `shortDescription`: scoreProviderSkill ranks the short one at 20, the full one at 30. */
  longDescription?: string | null;
  enabled: boolean; userInvocationOnly: boolean; userInvocable: boolean;
}

export function providerMetaFrom(records: Record<string, unknown>[]): Map<string, ProviderMeta> {
  const out = new Map<string, ProviderMeta>();
  for (const record of records) {
    const instanceId = str(record.instanceId);
    if (!instanceId) continue;
    out.set(instanceId, {
      instanceId,
      driver: str(record.driver) ?? instanceId,
      displayName: str(record.displayName) ?? instanceId,
      accentColor: str(record.accentColor),
    });
  }
  return out;
}

export function parseCommands(value: unknown): ProviderCommand[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ProviderCommand[] => {
    const item = asRecord(entry);
    const name = str(item?.name);
    if (!item || !name) return [];
    return [{ name, description: str(item.description), inputHint: str(asRecord(item.input)?.hint) }];
  });
}

export function parseSkills(value: unknown): ProviderSkill[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ProviderSkill[] => {
    const item = asRecord(entry);
    const name = str(item?.name);
    const path = str(item?.path);
    if (!item || !name || !path) return [];
    return [{
      name, path, displayName: str(item.displayName), description: str(item.shortDescription) ?? str(item.description),
      ...(str(item.shortDescription) ? { longDescription: str(item.description) } : {}),
      scope: str(item.scope), enabled: item.enabled !== false,
      userInvocationOnly: item.userInvocationOnly === true, userInvocable: item.userInvocable !== false,
    }];
  });
}

export const providerMetas = computed(() => providerMetaFrom(rawProviderRecords()));
export const providerMetaFor = (instanceId: string) => providerMetas().get(instanceId) ?? null;

/** The raw snapshot of the selected model's provider instance. */
export const selectedProviderRecord = computed(() => {
  const choice = selectedModel();
  return choice ? rawProviderRecords().find((item) => item.instanceId === choice.provider) ?? null : null;
});

export const providerCommands = computed(() => parseCommands(selectedProviderRecord()?.slashCommands));
export const providerSkills = computed(() => parseSkills(selectedProviderRecord()?.skills));
/** The selected provider's usage limits, or null when it reports none. */
export const providerUsageLimits = computed(() => parseUsageLimits(selectedProviderRecord()?.usageLimits));

/** A model's descriptors with the user's picks applied. */
export function modelDescriptors(model: AvailableModel | null): Descriptor[] {
  if (!model) return [];
  // An OpenCode model the catalog no longer lists: its saved options show read-only (TraitsPicker modelIsUnavailable).
  if (model.driver === "opencode" && !availableModels().some((entry) => entry.provider === model.provider && entry.model === model.model)) return unavailableModelOptionDescriptors(modelOptionsFor(model.provider, model.model));
  return descriptorsWithSelections(withoutPlanAgentOption(parseDescriptors(model.optionDescriptors)), modelOptionsFor(model.provider, model.model));
}

export const selectedDescriptors = computed(() => modelDescriptors(selectedModel()));
