// Pure logic behind the model picker popover (ModelPickerContent.tsx in the web app).
import type { AvailableModel } from "../../store";
import { groupModels } from "../thread/modelGroups";

export type PickerTab = "favorites" | string;

export interface PickerProvider { provider: string; label: string }
export interface PickerRow { provider: string; providerLabel: string; model: string; name: string; key: string }

export const modelKey = (provider: string, model: string) => `${provider}:${model}`;

export function pickerProviders(models: AvailableModel[]): PickerProvider[] {
  return groupModels(models).map((group) => ({ provider: group.provider, label: group.label }));
}

export function pickerRows(models: AvailableModel[]): PickerRow[] {
  return groupModels(models).flatMap((group) =>
    group.models.map((entry) => ({
      provider: group.provider,
      providerLabel: group.label,
      model: entry.model,
      name: entry.label,
      key: modelKey(group.provider, entry.model),
    })));
}

/** Words of the query must each appear in the model name or its provider's name. */
export function matchesSearch(row: PickerRow, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${row.name} ${row.providerLabel} ${row.model}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/**
 * What the list shows. A search covers every provider (the sidebar hides while
 * searching, as in the web app); otherwise the selected tab: Favorites or one provider.
 */
export function visibleRows(rows: PickerRow[], tab: PickerTab, query: string, favorites: ReadonlySet<string>): PickerRow[] {
  if (query.trim().length > 0) return rows.filter((row) => matchesSearch(row, query));
  if (tab === "favorites") return rows.filter((row) => favorites.has(row.key));
  return rows.filter((row) => row.provider === tab);
}

export function emptyLabel(tab: PickerTab, query: string): string {
  return tab === "favorites" && query.trim().length === 0 ? "No favorites yet" : "No models found";
}

/** The tab a freshly opened picker starts on: the selected model's provider. */
export function initialTab(rows: PickerRow[], selected: { provider: string } | null): PickerTab {
  return selected && rows.some((row) => row.provider === selected.provider) ? selected.provider : (rows[0]?.provider ?? "favorites");
}

/** Up/Down move the highlight and stop at the ends, as the combobox does. */
export function moveHighlight(index: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return Math.max(0, Math.min(length - 1, index + delta));
}
