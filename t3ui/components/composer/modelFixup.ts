// composerDraftStore deriveEffectiveComposerModelState + modelSelection.ts resolveAppModelSelectionForInstance /
// resolveAppModelSelection + providerModels.ts resolveSelectableProvider: the model the composer settles on when the
// providers update. The thread's (or project's) pick stands while its instance lists it; a model the instance no
// longer lists falls back to that instance's default model (an OpenCode / Antigravity pick is kept, as
// appendUnavailableDynamicModelSelection keeps it); an instance that is gone or off falls back to the requested
// driver's first enabled instance, else the first enabled one, else codex, and its default model.
type Dict = Record<string, unknown>;
export interface ModelChoice { provider: string; model: string }

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** getDefaultServerModel for one snapshot: the default non-custom model, else the first non-custom, else the first. */
export function defaultModelOf(record: Dict): string | null {
  const models = Array.isArray(record.models) ? record.models.filter((item): item is Dict => typeof item === "object" && item !== null && typeof (item as Dict).slug === "string") : [];
  return (models.find((item) => item.isDefault === true && item.isCustom !== true)?.slug as string | undefined)
    ?? (models.find((item) => item.isCustom !== true)?.slug as string | undefined)
    ?? (models[0]?.slug as string | undefined) ?? null;
}

/** resolveSelectableProvider: the requested instance's driver when it is enabled, else the first enabled driver, else codex. */
export function resolveSelectableDriver(records: readonly Dict[], requested: string | null | undefined): string {
  const entry = records.find((record) => record.instanceId === requested);
  if (entry && entry.enabled !== false) return text(entry.driver) ?? "codex";
  return text(records.find((record) => record.enabled !== false)?.driver) ?? "codex";
}

export function resolveEffectiveComposerModel<T extends ModelChoice>(input: {
  selection: ModelChoice | null;
  available: readonly T[];
  records: readonly Dict[];
  retained?: ModelChoice | null;
}): T | null {
  const find = (provider: string, model: string | null | undefined) => (model ? input.available.find((item) => item.provider === provider && item.model === model) : undefined);
  const selection = input.selection;
  if (selection) {
    const listed = find(selection.provider, selection.model);
    if (listed) return listed;
    const instance = input.records.find((record) => record.instanceId === selection.provider);
    if (instance && instance.enabled !== false) {
      // An OpenCode or Antigravity pick the provider stopped listing stays in the picker as an unavailable row
      // (appendUnavailableSelection); the composer itself settles on a listed model.
      const fallback = find(selection.provider, defaultModelOf(instance));
      if (fallback) return fallback;
    }
    const driver = resolveSelectableDriver(input.records, selection.provider);
    const sameDriver = input.records.find((record) => record.enabled !== false && record.driver === driver);
    const byDriver = sameDriver ? find(text(sameDriver.instanceId) ?? "", defaultModelOf(sameDriver)) : undefined;
    if (byDriver) return byDriver;
  }
  const retained = input.retained ? find(input.retained.provider, input.retained.model) : undefined;
  return retained ?? input.available[0] ?? null;
}
