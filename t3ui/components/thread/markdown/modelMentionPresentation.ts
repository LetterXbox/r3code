// ModelMentionChip.tsx modelMentionPresentationAtom: a `model:<instance>/<model>` mention resolves against the provider snapshots;
// a mention of a provider instance or model the server does not list stays as written.
import { rawProviderRecords } from "../../../store";
import { displayModelName, instanceDisplayName } from "../../composer/pickerModel";
import type { ModelMentionPresentation } from "./modelMentions";

const dict = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Pure form of the lookup, over provider snapshot records. */
export function resolveModelMentionIn(records: readonly Record<string, unknown>[], instanceId: string, model: string): ModelMentionPresentation | null {
  const record = records.find((candidate) => candidate.instanceId === instanceId);
  if (!record) return null;
  const option = (Array.isArray(record.models) ? record.models : []).map(dict).find((candidate) => candidate?.slug === model);
  if (!option) return null;
  const subProvider = text(option.subProvider);
  const name = text(option.name) ?? model;
  const providerDisplayName = instanceDisplayName(record);
  return {
    label: displayModelName({ name, subProvider }),
    providerLabel: subProvider ?? providerDisplayName,
    driver: text(record.driver) ?? instanceId,
    providerDisplayName,
    accentColor: text(record.accentColor),
    instanceId,
  };
}

/** The resolver a message surface hands ChatMarkdown; reads the live snapshots, so a computed using it follows them. */
export const resolveModelMention = (instanceId: string, model: string): ModelMentionPresentation | null => resolveModelMentionIn(rawProviderRecords() as Record<string, unknown>[], instanceId, model);
