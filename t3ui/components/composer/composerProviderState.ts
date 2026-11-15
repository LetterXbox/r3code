// composerProviderState.tsx getComposerProviderState, the part that decides which option selections a send carries.
export interface OptionSelection { id: string; value: string | boolean }

/**
 * opencode: a model the catalog no longer lists keeps the options the user saved for it (its descriptors are gone, so they cannot be
 * rebuilt), minus the plan agent, which the composer never sends (plan mode is the interaction mode) unless `includePlanAgent`.
 * Anything else returns undefined: the caller derives the selections from the model's descriptors as before.
 */
export function preservedOpenCodeOptions(input: {
  driver: string | undefined;
  model: string;
  catalog: readonly { model: string }[];
  options: readonly OptionSelection[] | undefined;
  includePlanAgent?: boolean;
}): { applies: false } | { applies: true; options: OptionSelection[] | undefined } {
  if (input.driver !== "opencode" || input.catalog.some((entry) => entry.model === input.model)) return { applies: false };
  const kept = (input.options ?? []).filter((option) => input.includePlanAgent || option.id !== "agent" || option.value !== "plan");
  return { applies: true, options: kept.length > 0 ? kept : undefined };
}
