import { mount, signal, View } from "nsh";
import { createThread, type AvailableModel } from "../../store";
import { ModelPicker } from "./ModelPicker";
import { defineContext, installKeybindings, registerCommands } from "../../commands/registry";
import { modelPickerOpen } from "../composer/composerControls";

createThread(null);
defineContext("modelPickerOpen", () => modelPickerOpen());
registerCommands({ "modelPicker.toggle": () => { modelPickerOpen.set(!modelPickerOpen()); } });
installKeybindings();
const models: AvailableModel[] = [
  { provider: "first", model: "model-a", label: "Provider A: Model A" },
  { provider: "second", model: "model-b", label: "Provider B: Model B" },
];
const selected = signal<AvailableModel | null>(models[0]);
function Fixture() {
  return <View><ModelPicker models={() => models} selected={selected} disabled={() => false} open={modelPickerOpen}
    onSelect={(provider, model) => selected.set(models.find((entry) => entry.provider === provider && entry.model === model) ?? null)}
  /></View>;
}
mount(Fixture);
