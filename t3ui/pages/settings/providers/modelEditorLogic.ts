// customModelEditor.logic.ts: the draft a custom model's capability editor works on, and its
// conversion to and from the saved `capabilities.optionDescriptors`.
import type { Rec } from "./logic";

export interface EditorChoice { key: string; id: string; label: string; isDefault: boolean; description?: string }
export interface EditorDescriptor {
  key: string; type: "select" | "boolean"; id: string; label: string; choices: EditorChoice[];
  currentBooleanValue?: boolean | undefined; description?: string | undefined;
}
export interface CustomModelDraft { slug: string; name: string; descriptors: EditorDescriptor[] }
export interface DescriptorPreset { id: string; label: string; type: "select" | "boolean"; choices?: { id: string; label: string; isDefault?: boolean }[] }

const EFFORT_CHOICES = [
  { id: "low", label: "Low" }, { id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }, { id: "xhigh", label: "Extra High" },
];

export const DESCRIPTOR_PRESETS_BY_DRIVER: Record<string, DescriptorPreset[]> = {
  codex: [
    { id: "reasoningEffort", label: "Reasoning", type: "select", choices: EFFORT_CHOICES },
    { id: "serviceTier", label: "Speed", type: "select", choices: [{ id: "default", label: "Standard", isDefault: true }, { id: "fast", label: "Fast" }] },
  ],
  claudeAgent: [
    { id: "effort", label: "Reasoning", type: "select", choices: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High", isDefault: true }, { id: "xhigh", label: "Extra High" }, { id: "max", label: "Max" }] },
    { id: "fastMode", label: "Fast Mode", type: "boolean" },
    { id: "thinking", label: "Thinking", type: "boolean" },
  ],
  cursor: [
    { id: "reasoning", label: "Reasoning", type: "select", choices: EFFORT_CHOICES },
    { id: "fastMode", label: "Fast Mode", type: "boolean" },
    { id: "thinking", label: "Thinking", type: "boolean" },
  ],
  grok: [{ id: "reasoningEffort", label: "Reasoning", type: "select", choices: EFFORT_CHOICES }],
  pi: [{ id: "thinking", label: "Thinking", type: "select", choices: [
    { id: "off", label: "Off" }, { id: "minimal", label: "Minimal" }, { id: "low", label: "Low" }, { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" }, { id: "xhigh", label: "Extra High" }, { id: "max", label: "Max" }] }],
  opencode: [
    { id: "variant", label: "Reasoning", type: "select", choices: EFFORT_CHOICES },
    { id: "agent", label: "Agent", type: "select", choices: [{ id: "build", label: "Build", isDefault: true }, { id: "plan", label: "Plan" }] },
  ],
};

let nextKey = 0;
const newKey = () => `k${++nextKey}`;

export const choiceFromPreset = (choice: { id: string; label: string; isDefault?: boolean }): EditorChoice => ({ key: newKey(), id: choice.id, label: choice.label, isDefault: !!choice.isDefault });
export const descriptorFromPreset = (preset: DescriptorPreset): EditorDescriptor => ({ key: newKey(), type: preset.type, id: preset.id, label: preset.label, choices: (preset.choices ?? []).map(choiceFromPreset) });
export const emptyEditorDescriptor = (): EditorDescriptor => ({ key: newKey(), type: "select", id: "", label: "", choices: [] });
export const emptyEditorChoice = (): EditorChoice => ({ key: newKey(), id: "", label: "", isDefault: false });

const text = (value: unknown): string => typeof value === "string" ? value : "";

/** Custom entries lack runtime profiles for prompt-injected choices, so those are not kept as ordinary options. */
function descriptorToEditor(descriptor: Rec): EditorDescriptor {
  const select = descriptor.type === "select";
  const injected = new Set<unknown>(select && Array.isArray(descriptor.promptInjectedValues) ? descriptor.promptInjectedValues : []);
  const options = (select && Array.isArray(descriptor.options) ? descriptor.options : []).filter((option): option is Rec => typeof option === "object" && option !== null && !injected.has((option as Rec).id));
  const chosen = options.find((option) => option.id === descriptor.currentValue) ?? options.find((option) => option.isDefault === true);
  return {
    key: newKey(), type: select ? "select" : "boolean", id: text(descriptor.id), label: text(descriptor.label),
    ...(typeof descriptor.description === "string" ? { description: descriptor.description } : {}),
    ...(!select && typeof descriptor.currentValue === "boolean" ? { currentBooleanValue: descriptor.currentValue } : {}),
    choices: options.map((option) => ({ key: newKey(), id: text(option.id), label: text(option.label), ...(typeof option.description === "string" ? { description: option.description } : {}), isDefault: option === chosen })),
  };
}

function optionDescriptors(capabilities: unknown): Rec[] {
  const list = (capabilities as { optionDescriptors?: unknown } | null | undefined)?.optionDescriptors;
  return Array.isArray(list) ? list.filter((item): item is Rec => typeof item === "object" && item !== null) : [];
}

export function draftFromEntry(entry: { slug: string; name: string; capabilities: unknown }): CustomModelDraft {
  return { slug: entry.slug, name: entry.name === entry.slug ? "" : entry.name, descriptors: optionDescriptors(entry.capabilities).map(descriptorToEditor) };
}

/** Descriptors copied from a built-in model. Claude's context window needs runtime suffix mappings a custom entry cannot carry. */
export function descriptorsFromModel(descriptors: Rec[], driver: string | null): EditorDescriptor[] {
  return descriptors.filter((descriptor) => driver !== "claudeAgent" || descriptor.id !== "contextWindow").map(descriptorToEditor);
}

export function validateDraft(draft: CustomModelDraft): string | null {
  const seen = new Set<string>();
  for (const [index, descriptor] of draft.descriptors.entries()) {
    const position = `Option ${index + 1}`;
    const id = descriptor.id.trim();
    if (!id) return `${position} needs an id.`;
    if (seen.has(id)) return `${position}: id "${id}" is used twice.`;
    seen.add(id);
    if (!descriptor.label.trim()) return `${position} needs a label.`;
    if (descriptor.type !== "select") continue;
    if (descriptor.choices.length === 0) return `${position} needs at least one choice.`;
    const choices = new Set<string>();
    for (const choice of descriptor.choices) {
      const choiceId = choice.id.trim();
      if (!choiceId) return `${position} has a choice without a value.`;
      if (choices.has(choiceId)) return `${position}: choice "${choiceId}" is used twice.`;
      choices.add(choiceId);
    }
  }
  return null;
}

export function entryFromDraft(draft: CustomModelDraft): { slug: string; name: string; capabilities: unknown } {
  const descriptors = draft.descriptors.map((descriptor): Rec => {
    const id = descriptor.id.trim();
    const label = descriptor.label.trim();
    if (descriptor.type === "boolean") {
      return { id, label, type: "boolean", ...(descriptor.description !== undefined ? { description: descriptor.description } : {}), ...(descriptor.currentBooleanValue !== undefined ? { currentValue: descriptor.currentBooleanValue } : {}) };
    }
    const options = descriptor.choices.map((choice) => ({
      id: choice.id.trim(), label: choice.label.trim() || choice.id.trim(),
      ...(choice.description !== undefined ? { description: choice.description } : {}), ...(choice.isDefault ? { isDefault: true } : {}),
    }));
    const currentValue = options.find((option) => option.isDefault)?.id;
    return { id, label, type: "select", ...(descriptor.description !== undefined ? { description: descriptor.description } : {}), options, ...(currentValue ? { currentValue } : {}) };
  });
  const name = draft.name.trim();
  return { slug: draft.slug, name: name || draft.slug, capabilities: descriptors.length > 0 ? { optionDescriptors: descriptors } : null };
}
