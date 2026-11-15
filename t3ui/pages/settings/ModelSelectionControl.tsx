// The model rows of the settings pages (`textGenerationModelSelection`, `sourceControlWriterModelSelection`,
// `reviewGuideModelSelection`, `speechPostProcessingModelSelection`): a model picker, and for the
// dedicated-model rows a switch that gives the task its own model or lets it follow the text generation model.
// Selections are `{ instanceId, model }` as TextGeneratorsSection's TaskPicker writes them.
import { signal, Text, View } from "nsh";
import { ModelPickerPopup } from "../../components/composer/ModelPickerPopup";
import { createAnchor } from "../../components/composer/Popover";
import { SettingsSwitch } from "../../components/SettingsLayout";
import { availableModels } from "../../store";
import type { AvailableModel } from "../../store";
import { triggerModelName } from "../../components/thread/ModelPicker";
import { ProviderIconView } from "./providers/ui";
import { readSelection, type ModelSelectionValue } from "./providers/textGenerators";
import { readSetting, writeSetting } from "./settingsSync";

const asRecord = (value: unknown) => value as Record<string, unknown>;

/** The model a task uses and whether it is its own: a dedicated selection, else the text generation model. */
export function modelSelectionState(settings: Record<string, unknown> | null, field: string, dedicated: boolean): { own: ModelSelectionValue | null; shown: ModelSelectionValue | null } {
  const own = readSelection(settings?.[field]);
  if (!dedicated) return { own, shown: own };
  return { own, shown: own ?? readSelection(settings?.textGenerationModelSelection) };
}

/** What the dedicated switch writes: off clears the selection, on starts from the model it follows (or the first one). */
export function dedicatedSwitchValue(on: boolean, following: ModelSelectionValue | null, models: readonly AvailableModel[]): ModelSelectionValue | null {
  if (!on) return null;
  if (following) return following;
  const first = models[0];
  return first ? { instanceId: first.provider, model: first.model } : null;
}

export function ModelPickerButton(props: { label: string; selection: () => ModelSelectionValue | null; onSelect: (selection: ModelSelectionValue) => void; /** What the trigger says with no selection (the fallback row says "None"). */ emptyLabel?: string }) {
  const open = signal(false);
  const anchor = createAnchor();
  const selected = (): AvailableModel | null => {
    const current = props.selection();
    if (!current) return null;
    return availableModels().find((model) => model.provider === current.instanceId && model.model === current.model)
      ?? { provider: current.instanceId, model: current.model, label: current.model, driver: current.instanceId };
  };
  // ProviderModelPicker's trigger: the display name without its family prefix (triggerModelName).
  const display = () => { const model = selected(); return model ? triggerModelName(model) : (props.emptyLabel ?? "Select model"); };
  return (
    <View>
      <View
        ref={anchor.ref}
        role="button"
        accessibilityLabel={`${props.label} model`}
        onPress={() => open.set(!open())}
        class="h-7 min-w-0 max-w-56 flex-row items-center gap-1.5 rounded-lg border border-input bg-background px-[9px] hover:bg-accent transition-colors duration-150 ease-in-out"
      >
        {selected() ? <ProviderIconView driver={selected()?.driver ?? ""} name={selected()?.label ?? ""} size={16} /> : null}
        {/* ProviderModelPicker's settings trigger draws no chevron (SETTINGS_PICKER_TRIGGER_CLASSNAME). */}
        <Text class="min-w-0 shrink truncate text-sm text-foreground">{display()}</Text>
      </View>
      {open() ? (
        <ModelPickerPopup
          anchor={anchor.anchor}
          models={() => availableModels()}
          selected={selected}
          onClose={() => open.set(false)}
          onSelect={(provider, model) => { props.onSelect({ instanceId: provider, model }); open.set(false); }}
        />
      ) : null}
    </View>
  );
}

export function ModelSelectionControl(props: { field: string; label: string; dedicated: boolean; /** The dedicated switch's accessible name when it differs from the picker's (Voice: "Use a separate cleanup model"). */ switchLabel?: string }) {
  const state = () => {
    const all = { [props.field]: readSetting(props.field, "server"), textGenerationModelSelection: readSetting("textGenerationModelSelection", "server") };
    return modelSelectionState(all, props.field, props.dedicated);
  };
  const write = (value: ModelSelectionValue | null) => void writeSetting(props.field, "server", value as never);
  return (
    <View class="flex-row items-center gap-3" testID={`${props.label} (${state().own ? "dedicated" : "following"})`}>
      {props.dedicated ? (
        <SettingsSwitch label={props.switchLabel ?? props.label} checked={state().own !== null} onChange={(on) => write(dedicatedSwitchValue(on, readSelectionOf("textGenerationModelSelection"), availableModels()))} />
      ) : null}
      {!props.dedicated || state().own ? <ModelPickerButton label={props.label} selection={() => state().shown} onSelect={write} /> : null}
    </View>
  );
}

function readSelectionOf(field: string): ModelSelectionValue | null {
  return readSelection(asRecord({ [field]: readSetting(field, "server") })[field]);
}
