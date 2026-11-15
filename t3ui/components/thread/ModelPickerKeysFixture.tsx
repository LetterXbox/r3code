// The docked model picker laid out inline: a model another provider cannot take (disabledReason), the ChatGPT plan footer,
// and the keyboard between the rail, the search field and the effort column.
import { mount, signal, Text, View } from "nsh";
import { createThread, type AvailableModel } from "../../store";
import { ModelPickerPopup } from "../composer/ModelPickerPopup";
import { ChatGptSharingControl } from "../composer/ChatGptSharingControl";
import { ModelPicker } from "./ModelPicker";
import { descriptorsWithSelections, parseDescriptors, replaceCurrentValue, selectionsFromDescriptors } from "../composer/modelTraits";
import type { OptionSelection } from "../composer/modelTraits";

createThread(null);
const effort = [
  { id: "effort", label: "Effort", type: "select", options: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }] },
];
const models: AvailableModel[] = [
  { provider: "first", model: "model-a", label: "Provider A: Model A", optionDescriptors: effort },
  { provider: "first", model: "model-c", label: "Provider A: Model C", optionDescriptors: effort },
  { provider: "second", model: "model-b", label: "Provider B: Model B" },
];
const selected = signal<AvailableModel | null>(models[0]);
const picks = signal<Record<string, OptionSelection[]>>({});
const key = () => `${selected()?.provider}:${selected()?.model}`;
const descriptors = () => descriptorsWithSelections(parseDescriptors(selected()?.optionDescriptors), picks()[key()]);
const change = (id: string, value: string | boolean) => picks.set({ ...picks(), [key()]: selectionsFromDescriptors(replaceCurrentValue(descriptors(), id, value)) ?? [] });
const picked = signal("none");
const gone: AvailableModel = { provider: "first", model: "retired", label: "Provider A: Retired", driver: "first" };

function Fixture() {
  return (
    <View>
      <ModelPickerPopup
        inline
        anchor={() => null}
        models={() => models}
        selected={selected}
        onSelect={(provider, model) => { picked.set(`${provider}/${model}`); selected.set(models.find((entry) => entry.provider === provider && entry.model === model) ?? null); }}
        onClose={() => {}}
        descriptors={descriptors}
        onTraitChange={change}
        disabledReason={(instanceId) => (instanceId === "second" ? "This thread does not support switching providers after it has started. Start a new thread to use this model." : null)}
        listFooter={<ChatGptSharingControl provider={() => ({ instanceId: "first", auth: { status: "authenticated", subscriptionSharing: true } })} />}
      />
      <Text>{`picked ${picked()}`}</Text>
      <Text>{`effort ${descriptors().find((entry) => entry.id === "effort")?.currentValue ?? "none"}`}</Text>
      <ModelPicker models={() => models} selected={() => gone} disabled={() => false} onSelect={() => {}} />
    </View>
  );
}
mount(Fixture);
