// CustomModelEditor.tsx: a custom model's display name and the composer options (capabilities) it carries.
import { signal, Text, View } from "nsh";
import { Input, Switch } from "nsh/base";
import { SettingsSelect } from "../../../components/SettingsLayout";
import type { CustomModel, ProviderModelView } from "./logic";
import {
  choiceFromPreset, DESCRIPTOR_PRESETS_BY_DRIVER, descriptorFromPreset, descriptorsFromModel, draftFromEntry, emptyEditorChoice, emptyEditorDescriptor, entryFromDraft, validateDraft,
  type CustomModelDraft, type EditorChoice, type EditorDescriptor,
} from "./modelEditorLogic";
import { ButtonText, ErrorText, IconButton, PillButton, UiIcon } from "./ui";

const CUSTOM_ID = "__custom__";
const COMPACT = "h-7 min-w-0 rounded-md border border-input bg-background px-2 text-xs text-foreground";

export function CustomModelEditor(props: { entry: CustomModel; driver: string | null; builtInModels: ProviderModelView[]; onSave: (next: CustomModel) => void; onCancel: () => void }) {
  const draft = signal<CustomModelDraft>(draftFromEntry(props.entry));
  const error = signal("");
  const presets = () => props.driver ? DESCRIPTOR_PRESETS_BY_DRIVER[props.driver] ?? [] : [];
  const copyCandidates = () => props.builtInModels.filter((model) => model.descriptors.length > 0);

  const change = (next: (current: CustomModelDraft) => CustomModelDraft) => { error.set(""); draft.update(next); };
  const updateDescriptor = (key: string, patch: Partial<EditorDescriptor>) => change((current) => ({ ...current, descriptors: current.descriptors.map((item) => item.key === key ? { ...item, ...patch } : item) }));
  const updateChoice = (descriptorKey: string, choiceKey: string, patch: Partial<EditorChoice>) => change((current) => ({
    ...current,
    descriptors: current.descriptors.map((item) => item.key !== descriptorKey ? item : {
      ...item, choices: item.choices.map((choice) => choice.key === choiceKey ? { ...choice, ...patch } : patch.isDefault ? { ...choice, isDefault: false } : choice),
    }),
  }));
  const idSelectValue = (descriptor: EditorDescriptor) => presets().some((preset) => preset.id === descriptor.id) ? descriptor.id : CUSTOM_ID;
  function applyPresetId(descriptor: EditorDescriptor, value: string) {
    if (value === CUSTOM_ID) { updateDescriptor(descriptor.key, { id: "" }); return; }
    const preset = presets().find((candidate) => candidate.id === value);
    if (!preset) return;
    updateDescriptor(descriptor.key, { id: preset.id, label: preset.label, type: preset.type, choices: (preset.choices ?? []).map(choiceFromPreset), currentBooleanValue: undefined, description: undefined });
  }
  function copyFrom(slug: string) {
    const model = copyCandidates().find((candidate) => candidate.slug === slug);
    if (model) change((current) => ({ ...current, descriptors: descriptorsFromModel(model.descriptors, props.driver) }));
  }
  function save() {
    const problem = validateDraft(draft());
    if (problem) { error.set(problem); return; }
    props.onSave(entryFromDraft(draft()) as CustomModel);
  }

  const renderChoice = (descriptor: EditorDescriptor, choice: EditorChoice) => <View class="flex-row items-center gap-2">
    <Input accessibilityLabel="Choice value" value={choice.id} placeholder="value" autoCapitalize="none" autoCorrect={false} onChange={(event) => updateChoice(descriptor.key, choice.key, { id: event.value })} class={`${COMPACT} w-28 font-mono`} />
    <Input accessibilityLabel="Choice label" value={choice.label} placeholder="Label" onChange={(event) => updateChoice(descriptor.key, choice.key, { label: event.value })} class={`${COMPACT} flex-1`} />
    <View class="shrink-0 flex-row items-center gap-1.5">
      <Switch checked={choice.isDefault} onChange={(event: { checked?: boolean }) => updateChoice(descriptor.key, choice.key, { isDefault: event.checked === true })}
        accessibilityLabel="Default choice" testID={`Default choice ${choice.isDefault ? "on" : "off"}`}
        class="h-4 w-6.5 items-center" trackClass="h-4 w-6.5 justify-center rounded-full bg-input checked:bg-primary transition-colors duration-200 ease-in-out" thumbClass="size-3 rounded-full bg-background checked:translate-x-2.5 transition-transform duration-150 ease-in-out" />
      <Text class="text-2xs text-muted-foreground">Default</Text>
    </View>
    <IconButton label="Remove choice" icon="x" size={12} onPress={() => updateDescriptor(descriptor.key, { choices: descriptor.choices.filter((candidate) => candidate.key !== choice.key) })} />
  </View>;

  const renderDescriptor = (descriptor: EditorDescriptor, index: number) => <View class="gap-2 rounded-md border border-border-60 p-2.5">
    <View class="flex-row flex-wrap items-center gap-2">
      <Text class="w-14 shrink-0 text-2xs text-muted-foreground">{`Option ${index + 1}`}</Text>
      {presets().length > 0 ? <SettingsSelect label="Option id" value={idSelectValue(descriptor)}
        options={[...presets().map((preset) => ({ value: preset.id, label: preset.id })), { value: CUSTOM_ID, label: "Custom…" }]} onChange={(next) => applyPresetId(descriptor, next)} /> : null}
      {idSelectValue(descriptor) === CUSTOM_ID ? <Input accessibilityLabel="Option id" value={descriptor.id} placeholder="optionId" autoCapitalize="none" autoCorrect={false}
        onChange={(event) => updateDescriptor(descriptor.key, { id: event.value })} class={`${COMPACT} w-36 font-mono`} /> : null}
      <Input accessibilityLabel="Option label" value={descriptor.label} placeholder="Label" onChange={(event) => updateDescriptor(descriptor.key, { label: event.value })} class={`${COMPACT} flex-1`} />
      <SettingsSelect label="Option type" value={descriptor.type} options={[{ value: "select", label: "Choices" }, { value: "boolean", label: "Toggle" }]}
        onChange={(next) => updateDescriptor(descriptor.key, { type: next === "boolean" ? "boolean" : "select" })} />
      <IconButton label={`Remove option ${index + 1}`} icon="x" size={12} onPress={() => change((current) => ({ ...current, descriptors: current.descriptors.filter((item) => item.key !== descriptor.key) }))} />
    </View>
    {descriptor.type === "select" ? <View class="gap-1.5 pl-16">
      <Each of={descriptor.choices} key={(choice) => choice.key}>{(choice) => renderChoice(descriptor, choice())}</Each>
      <PillButton label="Add choice" size="xs" variant="ghost" onPress={() => updateDescriptor(descriptor.key, { choices: [...descriptor.choices, emptyEditorChoice()] })}>
        <UiIcon name="plus" size={12} /><ButtonText tone="muted">Add choice</ButtonText></PillButton>
    </View> : null}
  </View>;

  return <View testID={`custom model editor ${props.entry.slug}`} class="mx-2 mt-1 mb-2 gap-3 rounded-md border border-border p-3">
    <View class="gap-1">
      <Text class="text-xs text-muted-foreground">Display name</Text>
      <Input accessibilityLabel={`Display name for ${props.entry.slug}`} autoFocus value={draft().name} placeholder={draft().slug} autoCapitalize="none" autoCorrect={false}
        onChange={(event) => change((current) => ({ ...current, name: event.value }))} onSubmit={save} class="h-8 w-72 rounded-md border border-input bg-background px-2.5 text-sm text-foreground" />
    </View>
    <View class="gap-2">
      <View class="flex-row flex-wrap items-center justify-between gap-2">
        <Text class="text-xs text-muted-foreground">Options shown in the composer</Text>
        {copyCandidates().length > 0 ? <SettingsSelect label="Copy options from a built-in model" value="" options={[{ value: "", label: "Copy from…" }, ...copyCandidates().map((model) => ({ value: model.slug, label: model.name }))]}
          onChange={(next) => { if (next) copyFrom(next); }} /> : null}
      </View>
      {draft().descriptors.length === 0 ? <Text class="text-xs text-muted-foreground">No custom options. The composer uses the provider's default options.</Text> : null}
      <Each of={draft().descriptors} key={(descriptor) => descriptor.key}>{(descriptor, index) => renderDescriptor(descriptor(), index())}</Each>
      <View class="flex-row flex-wrap gap-1">
        <Each of={presets().filter((preset) => !draft().descriptors.some((descriptor) => descriptor.id === preset.id))} key={(preset) => preset.id}>{(preset) =>
          <PillButton label={`Add ${preset().label} option`} size="xs" variant="ghost" onPress={() => change((current) => ({ ...current, descriptors: [...current.descriptors, descriptorFromPreset(preset())] }))}>
            <UiIcon name="plus" size={12} /><ButtonText tone="muted">{preset().label}</ButtonText></PillButton>}</Each>
        <PillButton label="Add custom option" size="xs" variant="ghost" onPress={() => change((current) => ({ ...current, descriptors: [...current.descriptors, emptyEditorDescriptor()] }))}>
          <UiIcon name="plus" size={12} /><ButtonText tone="muted">Custom option</ButtonText></PillButton>
      </View>
    </View>
    {error() ? <ErrorText>{error()}</ErrorText> : null}
    <View class="flex-row gap-2">
      <PillButton label={`Save ${props.entry.slug}`} onPress={save}><ButtonText>Save</ButtonText></PillButton>
      <PillButton label={`Cancel editing ${props.entry.slug}`} variant="ghost" onPress={props.onCancel}><ButtonText tone="muted">Cancel</ButtonText></PillButton>
    </View>
  </View>;
}
