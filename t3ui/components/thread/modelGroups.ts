import type { AvailableModel } from "../../store";

export interface ModelGroup {
  provider: string;
  label: string;
  models: { model: string; label: string }[];
}

export function groupModels(models: AvailableModel[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  for (const option of models) {
    const separator = option.label.indexOf(": ");
    const providerLabel = separator >= 0 ? option.label.slice(0, separator) : option.provider;
    const modelLabel = separator >= 0 ? option.label.slice(separator + 2) : option.label;
    let group = groups.get(option.provider);
    if (!group) {
      group = { provider: option.provider, label: providerLabel, models: [] };
      groups.set(option.provider, group);
    }
    group.models.push({ model: option.model, label: modelLabel });
  }
  return Array.from(groups.values());
}
