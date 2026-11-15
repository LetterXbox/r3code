import type { ProviderSkill } from "../providerCatalog";
import { modelDisplayName, skillDisplayName } from "../commandItems";
import type { PromptTokenContext } from "./promptDocument";

/** What the editor chips: the provider's skills by name (with their display names) and the folders picked. */
export function promptTokenContext(skills: readonly ProviderSkill[], folders: ReadonlySet<string>, models: readonly { provider: string; model: string; label: string }[] = [], fileAttachments: ReadonlyMap<string, number> = new Map()): PromptTokenContext {
  return { skills: new Map(skills.map((skill) => [skill.name, skillDisplayName(skill)])), folders, models: new Map(models.map((item) => [`${item.provider}/${item.model}`, modelDisplayName(item.label)])), fileAttachments };
}
