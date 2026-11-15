// Model traits (effort, fast mode, context window, agent): the descriptor helpers of
// packages/client-runtime/src/modelTraits.ts and packages/shared/src/model.ts, plus the
// trigger/column presentation of chat/ComposerModelEffort.tsx and chat/EffortGlyph.tsx.
// Descriptors are the server's own `capabilities.optionDescriptors` for the model.

export interface OptionChoice { id: string; label: string; description?: string; isDefault?: boolean }
export interface SelectDescriptor {
  id: string; label: string; description?: string; type: "select"; options: OptionChoice[];
  currentValue?: string; promptInjectedValues?: string[]; role?: "reasoning";
}
export interface BooleanDescriptor { id: string; label: string; description?: string; type: "boolean"; currentValue?: boolean }
export type Descriptor = SelectDescriptor | BooleanDescriptor;
export interface OptionSelection { id: string; value: string | boolean }

const REASONING_IDS = new Set(["reasoningEffort", "effort", "reasoning", "variant", "reasoning_effort", "thinking_level", "thinking"]);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Parse the server's `optionDescriptors` array, dropping anything malformed. */
export function parseDescriptors(value: unknown): Descriptor[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): Descriptor[] => {
    const item = asRecord(entry);
    const id = text(item?.id);
    const label = text(item?.label);
    if (!item || !id || !label) return [];
    const description = text(item.description);
    if (item.type === "boolean") {
      return [{ id, label, type: "boolean", ...(description ? { description } : {}), ...(typeof item.currentValue === "boolean" ? { currentValue: item.currentValue } : {}) }];
    }
    if (item.type !== "select" || !Array.isArray(item.options)) return [];
    const options = item.options.flatMap((option): OptionChoice[] => {
      const choice = asRecord(option);
      const optionId = text(choice?.id);
      const optionLabel = text(choice?.label);
      if (!choice || !optionId || !optionLabel) return [];
      const optionDescription = text(choice.description);
      return [{ id: optionId, label: optionLabel, ...(optionDescription ? { description: optionDescription } : {}), ...(choice.isDefault === true ? { isDefault: true } : {}) }];
    });
    const injected = Array.isArray(item.promptInjectedValues) ? item.promptInjectedValues.filter((entry): entry is string => typeof entry === "string") : undefined;
    return [{
      id, label, type: "select", options,
      ...(description ? { description } : {}),
      ...(text(item.currentValue) ? { currentValue: text(item.currentValue) as string } : {}),
      ...(injected?.length ? { promptInjectedValues: injected } : {}),
      ...(item.role === "reasoning" ? { role: "reasoning" as const } : {}),
    }];
  });
}

/** The descriptors with the user's picked values applied as current values. */
export function descriptorsWithSelections(descriptors: Descriptor[], selections: readonly OptionSelection[] | undefined): Descriptor[] {
  return descriptors.map((descriptor) => {
    const picked = selections?.find((item) => item.id === descriptor.id)?.value;
    if (descriptor.type === "boolean") return typeof picked === "boolean" ? { ...descriptor, currentValue: picked } : { ...descriptor };
    return typeof picked === "string" ? { ...descriptor, currentValue: picked } : { ...descriptor };
  });
}

export function currentValue(descriptor: Descriptor): string | boolean | undefined {
  if (descriptor.type === "boolean") return descriptor.currentValue;
  return descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
}

export function currentLabel(descriptor: Descriptor): string | undefined {
  if (descriptor.type === "boolean") return typeof descriptor.currentValue === "boolean" ? (descriptor.currentValue ? "On" : "Off") : undefined;
  const value = currentValue(descriptor);
  return descriptor.options.find((option) => option.id === value)?.label;
}

/** Selections the descriptors currently resolve to (what a send carries). */
export function selectionsFromDescriptors(descriptors: Descriptor[]): OptionSelection[] | undefined {
  const out: OptionSelection[] = [];
  for (const descriptor of descriptors) {
    const value = currentValue(descriptor);
    if (typeof value === "string" || typeof value === "boolean") out.push({ id: descriptor.id, value });
  }
  return out.length ? out : undefined;
}

export function replaceCurrentValue(descriptors: Descriptor[], id: string, value: string | boolean): Descriptor[] {
  return descriptors.map((descriptor) => {
    if (descriptor.id !== id) return descriptor;
    if (descriptor.type === "boolean") return typeof value === "boolean" ? { ...descriptor, currentValue: value } : descriptor;
    return typeof value === "string" ? { ...descriptor, currentValue: value } : descriptor;
  });
}

export const isReasoningControl = (descriptor: Descriptor) =>
  (descriptor.type === "select" && descriptor.role === "reasoning") || REASONING_IDS.has(descriptor.id);

/** model.ts isClaudeUltrathinkPrompt: the prompt names Ultrathink anywhere (as a whole word). */
export const isUltrathinkPrompt = (prompt: string) => /\bultrathink\b/i.test(prompt);

/**
 * TraitsPicker ultrathinkPromptControlled: when the reasoning control offers a prompt-injected "ultrathink" level and the
 * prompt names it, the effort reads Ultrathink (the prompt, not the picker, controls it).
 */
export function withPromptUltrathink(descriptors: Descriptor[], prompt: string): Descriptor[] {
  if (!isUltrathinkPrompt(prompt)) return descriptors;
  const index = descriptors.findIndex((descriptor) => descriptor.type === "select" && isReasoningControl(descriptor) && (descriptor.promptInjectedValues ?? []).includes("ultrathink"));
  if (index < 0) return descriptors;
  return descriptors.map((descriptor, at) => (at === index ? { ...descriptor, currentValue: "ultrathink" } as Descriptor : descriptor));
}

/** Whether the prompt currently controls the effort (TraitsPicker ultrathinkPromptControlled). */
export const ultrathinkPromptControlled = (descriptors: Descriptor[], prompt: string) => withPromptUltrathink(descriptors, prompt) !== descriptors;

/** Prompt-injected levels such as Ultrathink work when typed, but pickers do not offer them. */
export const selectableChoices = (descriptor: SelectDescriptor) =>
  descriptor.options.filter((option) => !descriptor.promptInjectedValues?.includes(option.id));

export interface TraitsView {
  descriptors: Descriptor[];
  selects: SelectDescriptor[];
  toggles: BooleanDescriptor[];
  hasAnyControls: boolean;
}

export function traitsView(descriptors: Descriptor[]): TraitsView {
  const selects = descriptors.filter((item): item is SelectDescriptor => item.type === "select");
  const toggles = descriptors.filter((item): item is BooleanDescriptor => item.type === "boolean");
  return { descriptors, selects, toggles, hasAnyControls: descriptors.length > 0 };
}

/** Service tiers, Claude's Fast mode and Ultracode sit in the picker footer, not the column. */
export function splitSpeed(view: TraitsView) {
  const speedSelect = view.selects.find((item) => item.id === "serviceTier") ?? null;
  const fastToggle = view.toggles.find((item) => item.id === "fastMode") ?? null;
  const ultracodeToggle = view.toggles.find((item) => item.id === "ultracode") ?? null;
  return {
    speedSelect, fastToggle, ultracodeToggle,
    columnSelects: view.selects.filter((item) => item !== speedSelect),
    columnToggles: view.toggles.filter((item) => item !== fastToggle && item !== ultracodeToggle),
  };
}

export type ColumnControl = { kind: "select"; descriptor: SelectDescriptor } | { kind: "boolean"; descriptor: BooleanDescriptor };

/** The reasoning control first, then every other option as one row each. */
export function columnControls(view: TraitsView): { effort: ColumnControl | null; others: ColumnControl[] } {
  const { columnSelects, columnToggles } = splitSpeed(view);
  const controls: ColumnControl[] = [
    ...columnSelects.map((descriptor): ColumnControl => ({ kind: "select", descriptor })),
    ...columnToggles.map((descriptor): ColumnControl => ({ kind: "boolean", descriptor })),
  ];
  const effort = controls.find((control) => isReasoningControl(control.descriptor)) ?? null;
  return { effort, others: controls.filter((control) => control !== effort) };
}

const NAMED_LEVELS = new Set(["ultracode", "max"]);
const OFF_LEVELS = new Set(["off", "none"]);
const MAX_BARS = 7;

/** Bars for an effort select: one per ordinary level, filled up to the current one. */
export function resolveEffortGlyph(descriptor: SelectDescriptor, current: string | null) {
  const special = new Set([...(descriptor.promptInjectedValues ?? []), ...NAMED_LEVELS]);
  const levels = descriptor.options.filter((option) => !special.has(option.id));
  if (levels.length < 2 || levels.length > MAX_BARS || current === null) return null;
  const startsAtOff = OFF_LEVELS.has(levels[0]!.id);
  const count = startsAtOff ? levels.length - 1 : levels.length;
  if (special.has(current)) {
    const label = descriptor.options.find((option) => option.id === current)?.label ?? current;
    return { count, filled: count, special: label, label };
  }
  const index = levels.findIndex((option) => option.id === current);
  if (index < 0) return null;
  return { count, filled: startsAtOff ? index : index + 1, special: null as string | null, label: levels[index]!.label };
}

/** Bar heights rising by one whole-pixel step, from about half height up to `maxBar`. */
export function effortBarHeights(count: number, maxBar: number): number[] {
  const step = Math.max(1, Math.round(maxBar / 2 / Math.max(count - 1, 1)));
  return Array.from({ length: count }, (_, index) => maxBar - (count - 1 - index) * step);
}

export interface TraitsDisplay { label: string; speedLabel: string | null; ultracode: boolean }

function speedOf(descriptor: Descriptor): { label: string | null; fallback: string } | null {
  if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
    const label = descriptor.currentValue === true ? "Fast" : null;
    return { label, fallback: label ?? "Normal" };
  }
  if (descriptor.id !== "serviceTier" || descriptor.type !== "select") return null;
  const value = currentValue(descriptor);
  const fast = descriptor.options.find((option) => option.label === "Fast");
  const ultra = descriptor.options.find((option) => option.label === "Ultrafast");
  if (!(((fast || ultra) && value === "default") || (fast && value === fast.id) || (ultra && value === ultra.id))) return null;
  const label = ultra && value === ultra.id ? "Ultrafast" : fast && value === fast.id ? "Fast" : null;
  return { label, fallback: descriptor.options.find((option) => option.id === value)?.label ?? "Normal" };
}

/** getTraitsSpeedDisplay's speedIcon over a model's descriptors with its selection applied: the bolt (Fast) or the ultrafast mark. */
export function speedIconFor(descriptors: readonly Descriptor[], selections: readonly OptionSelection[] | undefined): "fast" | "ultrafast" | null {
  for (const descriptor of descriptorsWithSelections([...descriptors], selections)) {
    const speed = speedOf(descriptor);
    if (!speed?.label) continue;
    return speed.label === "Ultrafast" ? "ultrafast" : "fast";
  }
  return null;
}

/** buildTraitsTriggerDisplay: every shown trait joined with " · ", speed folded into the reasoning label. */
export function buildTraitsDisplay(descriptors: Descriptor[]): TraitsDisplay {
  let fallback: string | null = null;
  let speedLabel: string | null = null;
  let reasoningIndex = -1;
  let ultracodeIndex = -1;
  const labels: string[] = [];
  for (const descriptor of descriptors) {
    const speed = speedOf(descriptor);
    if (speed) { speedLabel = speed.label; fallback = speed.fallback; continue; }
    if (descriptor.id === "ultracode" && descriptor.type === "boolean") {
      if (descriptor.currentValue === true) { ultracodeIndex = labels.length; labels.push(descriptor.label); }
      continue;
    }
    const label = descriptor.type === "boolean"
      ? `${descriptor.label} ${descriptor.currentValue === true ? "On" : "Off"}`
      : (currentLabel(descriptor) ?? null);
    if (typeof label === "string" && label.length > 0) {
      if (reasoningIndex === -1 && descriptor.type === "select" && isReasoningControl(descriptor)) reasoningIndex = labels.length;
      labels.push(label);
    }
  }
  const ultracode = ultracodeIndex >= 0;
  if (labels.length === 0 && fallback !== null) return { label: fallback, speedLabel, ultracode };
  if (speedLabel) {
    if (reasoningIndex >= 0) labels[reasoningIndex] = `${labels[reasoningIndex]} ${speedLabel}`;
    else labels.push(speedLabel);
  }
  return { label: labels.join(" · "), speedLabel, ultracode };
}

export interface EffortSuffix {
  /** Word shown after the model name: the level's name (setting "label") or a special level. */
  word: string | null;
  glyph: { count: number; filled: number } | null;
  fast: boolean;
  ultrafast: boolean;
  ultracode: boolean;
  contextWindow: string | null;
  /** Names the suffix for the tooltip and the accessibility label. */
  detail: string | null;
}

/** describeComposerEffort: what the model trigger shows after the model name. */
export function describeEffort(descriptors: Descriptor[], effortDisplay: "bars" | "label" = "label"): EffortSuffix | null {
  if (descriptors.length === 0) return null;
  const view = traitsView(descriptors);
  const display = buildTraitsDisplay(descriptors);
  const reasoning = columnControls(view).effort?.descriptor ?? null;
  const glyph = reasoning?.type === "select" ? resolveEffortGlyph(reasoning, (currentValue(reasoning) as string | undefined) ?? null) : null;
  const word = glyph
    ? (glyph.special ?? (effortDisplay === "label" ? glyph.label : null))
    : !reasoning ? null
    : reasoning.type === "boolean" ? `${reasoning.label} ${reasoning.currentValue === true ? "On" : "Off"}`
    : (currentLabel(reasoning) ?? null);
  const contextDescriptor = view.selects.find((item) => item.id === "contextWindow");
  const contextWindow = (contextDescriptor && currentLabel(contextDescriptor)) || null;
  const fast = display.speedLabel === "Fast" || display.speedLabel === "Ultrafast";
  return {
    word, glyph: glyph ? { count: glyph.count, filled: glyph.filled } : null, fast,
    ultrafast: display.speedLabel === "Ultrafast", ultracode: display.ultracode, contextWindow, detail: display.label || null,
  };
}

/** Walk a reasoning select one level in `direction` (the composer.effort shortcut), skipping non-pickable levels. */
export function stepReasoning(descriptors: Descriptor[], direction: 1 | -1): { id: string; value: string } | null {
  const descriptor = descriptors.find((item): item is SelectDescriptor => item.type === "select" && isReasoningControl(item));
  if (!descriptor) return null;
  const choices = selectableChoices(descriptor);
  if (choices.length < 2) return null;
  const ordered = direction > 0 ? descriptor.options : [...descriptor.options].reverse();
  const current = currentValue(descriptor);
  const position = ordered.findIndex((option) => option.id === current);
  const next = [...ordered.slice(position + 1), ...ordered.slice(0, Math.max(position, 0))].find((option) => choices.includes(option));
  return next ? { id: descriptor.id, value: next.id } : null;
}

/** getProviderModelCapabilities' withoutPlanAgentOption (providerModels.ts:67-84): the composer never offers the "plan"
 * agent option (plan mode is the interaction mode); an agent select left empty goes, and its current value falls back to
 * the default option. Settings pass `include` when the stored selection already picks it (selectsPlanAgent). */
export function withoutPlanAgentOption(descriptors: readonly Descriptor[], include = false): Descriptor[] {
  if (include) return [...descriptors];
  return descriptors.flatMap((descriptor): Descriptor[] => {
    if (descriptor.type !== "select" || descriptor.id !== "agent") return [descriptor];
    const options = descriptor.options.filter((option) => option.id !== "plan");
    if (options.length === 0) return [];
    const currentValue = descriptor.currentValue && options.some((option) => option.id === descriptor.currentValue)
      ? descriptor.currentValue
      : (options.find((option) => option.isDefault)?.id ?? options[0]?.id);
    return [{ ...descriptor, options, ...(currentValue ? { currentValue } : {}) }];
  });
}

/** selectsPlanAgent (modelSelection.ts:369-371). */
export function selectsPlanAgent(options: readonly { id: string; value: unknown }[] | undefined): boolean {
  return options?.some((option) => option.id === "agent" && option.value === "plan") ?? false;
}

const SAVED_OPTION_LABELS: Readonly<Record<string, string>> = { agent: "Agent", effort: "Effort", reasoningEffort: "Reasoning effort", variant: "Reasoning" };
const savedOptionLabel = (id: string): string => SAVED_OPTION_LABELS[id] ?? id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase());

/**
 * TraitsPicker buildUnavailableModelOptionDescriptors: an OpenCode model the catalog no longer lists has no descriptors, so the
 * options saved for it show as they were, each a read-only row (a select offering only its saved value, a boolean as it was).
 * The plan agent is left out unless `includePlanAgent`.
 */
export function unavailableModelOptionDescriptors(selections: readonly OptionSelection[] | null | undefined, includePlanAgent = false): Descriptor[] {
  return (selections ?? [])
    .filter((selection) => includePlanAgent || selection.id !== "agent" || selection.value !== "plan")
    .map((selection): Descriptor => typeof selection.value === "boolean"
      ? { id: selection.id, label: savedOptionLabel(selection.id), type: "boolean", currentValue: selection.value }
      : { id: selection.id, label: savedOptionLabel(selection.id), type: "select", options: [{ id: selection.value, label: selection.value }], currentValue: selection.value });
}
