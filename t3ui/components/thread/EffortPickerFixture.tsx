import { mount, signal, View } from "nsh";
import { createThread, type AvailableModel } from "../../store";
import { descriptorsWithSelections, parseDescriptors, replaceCurrentValue, selectionsFromDescriptors } from "../composer/modelTraits";
import type { OptionSelection } from "../composer/modelTraits";
import { SpeedControls } from "../composer/SpeedControls";
import { ModelPicker } from "./ModelPicker";
import { PickerFooter } from "./ModeControls";

createThread(null);
const effort = [
  { id: "effort", label: "Effort", type: "select", options: [
    { id: "low", label: "Low" }, { id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" },
  ] },
  { id: "fastMode", label: "Fast mode", type: "boolean" },
  { id: "contextWindow", label: "Context window", type: "select", options: [{ id: "200k", label: "200k", isDefault: true }, { id: "1m", label: "1M" }] },
];
const models: AvailableModel[] = [
  { provider: "first", model: "model-a", label: "Provider A: Model A", optionDescriptors: effort },
  { provider: "second", model: "model-b", label: "Provider B: Model B" },
];
const selected = signal<AvailableModel | null>(models[0]);
const picks = signal<Record<string, OptionSelection[]>>({});
const key = () => `${selected()?.provider}:${selected()?.model}`;
const descriptors = () => descriptorsWithSelections(parseDescriptors(selected()?.optionDescriptors), picks()[key()]);
const change = (id: string, value: string | boolean) =>
  picks.set({ ...picks(), [key()]: selectionsFromDescriptors(replaceCurrentValue(descriptors(), id, value)) ?? [] });

function Fixture() {
  return <View><ModelPicker models={() => models} selected={selected} disabled={() => false}
    onSelect={(provider, model) => selected.set(models.find((entry) => entry.provider === provider && entry.model === model) ?? null)}
    descriptors={descriptors} onTraitChange={change}
    footer={<PickerFooter disabled={() => false} runtime={() => "full-access"} availableRuntime={() => []} interaction={() => "default"} availableInteraction={() => ["default"]}
      onRuntime={() => {}} onInteraction={() => {}} leading={<SpeedControls descriptors={descriptors} onChange={change} />} />}
  /></View>;
}
mount(Fixture);
