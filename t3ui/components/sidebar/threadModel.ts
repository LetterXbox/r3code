// What a thread's hover card says about the model: the trigger's short name ("Haiku 5.5"), read from the
// server's provider snapshot the way getTriggerDisplayModelName reads the provider entry, falling back to
// the raw slug when the snapshot has no such model.
import { rawProviderRecords } from "../../store";
import type { Thread } from "../../store";
import { modelShortName } from "../composer/modelShortName";
import { providerMetaFor } from "../composer/providerCatalog";

export interface ThreadModelFact {
  label: string;
  driver: string;
  providerName: string;
}

export function threadModelFact(thread: Thread): ThreadModelFact | null {
  const instanceId = thread.meta?.providerInstanceId;
  const model = thread.meta?.model;
  if (!instanceId) return null;
  const meta = providerMetaFor(instanceId);
  if (!meta) return null;
  const record = rawProviderRecords().find((item) => item.instanceId === instanceId);
  const models = Array.isArray(record?.models) ? record.models : [];
  const entry = models.find((item): item is Record<string, unknown> => typeof item === "object" && item !== null && (item as Record<string, unknown>).slug === model);
  const name = typeof entry?.name === "string" ? entry.name : (model ?? "");
  if (!name) return null;
  return { label: modelShortName(name, meta.driver), driver: meta.driver, providerName: meta.displayName };
}

/** Provider names the thread ran on before its current one, oldest first. */
export function handedOffFrom(thread: Thread): string[] {
  const current = thread.meta?.providerInstanceId;
  return (thread.meta?.providerInstanceHistory ?? [])
    .filter((id) => id !== current)
    .map((id) => providerMetaFor(id)?.displayName ?? id);
}
