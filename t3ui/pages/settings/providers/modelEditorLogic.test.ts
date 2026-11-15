import { expect, test } from "nsh/test";
import { descriptorFromPreset, descriptorsFromModel, DESCRIPTOR_PRESETS_BY_DRIVER, draftFromEntry, emptyEditorChoice, emptyEditorDescriptor, entryFromDraft, validateDraft } from "./modelEditorLogic";

test("a saved entry round-trips through the draft and keeps its default choice", () => {
  const entry = { slug: "gpt-x", name: "GPT X", capabilities: { optionDescriptors: [
    { id: "reasoningEffort", label: "Reasoning", type: "select", options: [{ id: "low", label: "Low" }, { id: "high", label: "High", isDefault: true }], currentValue: "high" },
    { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue: true },
  ] } };
  const draft = draftFromEntry(entry);
  expect(draft.name).toBe("GPT X");
  expect(draft.descriptors[0]?.choices.map((choice) => choice.isDefault)).toEqual([false, true]);
  expect(entryFromDraft(draft)).toEqual(entry);
});

test("an unnamed entry keeps its slug as the name and no options saves null capabilities", () => {
  const draft = draftFromEntry({ slug: "m", name: "m", capabilities: null });
  expect(draft.name).toBe("");
  expect(entryFromDraft(draft)).toEqual({ slug: "m", name: "m", capabilities: null });
});

test("prompt-injected choices are dropped and Claude's context window is not copied", () => {
  const copied = descriptorsFromModel([
    { id: "effort", label: "Reasoning", type: "select", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], promptInjectedValues: ["b"] },
    { id: "contextWindow", label: "Context", type: "select", options: [{ id: "1m", label: "1M" }] },
  ], "claudeAgent");
  expect(copied).toHaveLength(1);
  expect(copied[0]?.choices.map((choice) => choice.id)).toEqual(["a"]);
});

test("validateDraft reports the first problem in the reference's words", () => {
  const blank = emptyEditorDescriptor();
  expect(validateDraft({ slug: "m", name: "", descriptors: [blank] })).toBe("Option 1 needs an id.");
  expect(validateDraft({ slug: "m", name: "", descriptors: [{ ...blank, id: "x" }] })).toBe("Option 1 needs a label.");
  expect(validateDraft({ slug: "m", name: "", descriptors: [{ ...blank, id: "x", label: "X" }] })).toBe("Option 1 needs at least one choice.");
  expect(validateDraft({ slug: "m", name: "", descriptors: [{ ...blank, id: "x", label: "X", choices: [emptyEditorChoice()] }] })).toBe("Option 1 has a choice without a value.");
  const preset = descriptorFromPreset((DESCRIPTOR_PRESETS_BY_DRIVER.codex ?? [])[0] as any);
  expect(validateDraft({ slug: "m", name: "", descriptors: [preset, { ...preset }] })).toBe('Option 2: id "reasoningEffort" is used twice.');
  expect(validateDraft({ slug: "m", name: "", descriptors: [preset] })).toBeNull();
});
