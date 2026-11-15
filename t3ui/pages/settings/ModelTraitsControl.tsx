// TraitsPicker.tsx in a settings row: the selected model's own options (effort, fast mode, context window, agent) beside
// the model picker. Each select descriptor of the server's `optionDescriptors` is a small select and each boolean a
// switch; a change writes the model selection again with `options: [{ id, value }]`.
import { signal, Text, token, View } from "nsh";
import { Menu, MenuItem } from "nsh/base";
import { availableModels } from "../../store";
import { buildTraitsDisplay, currentValue, descriptorsWithSelections, isReasoningControl, parseDescriptors, selectableChoices, type Descriptor, type OptionSelection } from "../../components/composer/modelTraits";
import { ComposerIcon } from "../../components/composer/ComposerIcon";
import { MENU_ITEM_ROW_CLASS, MENU_POPUP_CLASS } from "../../components/menuStyles";
import { trackOpenChange, useOverlayOpen } from "../../components/rightPanel/nativeOcclusion";
import { SettingsIcon } from "./SettingsIcon";

type Dict = Record<string, unknown>;
export interface SelectionWithOptions { instanceId: string; model: string; options?: OptionSelection[] }

export function readSelectionWithOptions(value: unknown): SelectionWithOptions | null {
  const item = typeof value === "object" && value !== null ? (value as Dict) : null;
  if (!item || typeof item.instanceId !== "string" || typeof item.model !== "string") return null;
  const options = Array.isArray(item.options) ? item.options.flatMap((entry): OptionSelection[] => {
    const option = typeof entry === "object" && entry !== null ? (entry as Dict) : null;
    return option && typeof option.id === "string" && (typeof option.value === "string" || typeof option.value === "boolean") ? [{ id: option.id, value: option.value }] : [];
  }) : [];
  return { instanceId: item.instanceId, model: item.model, ...(options.length ? { options } : {}) };
}

/** The descriptors of the selected model, with its saved options applied; reasoning first. */
export function traitsFor(selection: SelectionWithOptions | null, models: readonly { provider: string; model: string; optionDescriptors?: unknown[] }[]): Descriptor[] {
  if (!selection) return [];
  const model = models.find((entry) => entry.provider === selection.instanceId && entry.model === selection.model);
  const descriptors = descriptorsWithSelections(parseDescriptors(model?.optionDescriptors ?? []), selection.options);
  return [...descriptors].sort((a, b) => Number(isReasoningControl(b)) - Number(isReasoningControl(a)));
}

/** The selection after one option changed: the others keep what they resolve to. */
export function withOption(selection: SelectionWithOptions, descriptors: readonly Descriptor[], id: string, value: string | boolean): SelectionWithOptions {
  const options: OptionSelection[] = descriptors.flatMap((descriptor) => {
    const current = descriptor.id === id ? value : currentValue(descriptor);
    return typeof current === "string" || typeof current === "boolean" ? [{ id: descriptor.id, value: current }] : [];
  });
  return { instanceId: selection.instanceId, model: selection.model, options };
}

/** TraitsPicker.tsx in a settings row (triggerClassName SETTINGS_PICKER_TRIGGER_CLASSNAME): one outline chip, a gauge
 * and the traits label (buildTraitsTriggerDisplay), opening a menu with each select option as a labelled radio group
 * and each boolean as a toggle row. */
export function ModelTraitsControl(props: { selection: () => SelectionWithOptions | null; onChange: (next: SelectionWithOptions) => void; label: string }) {
  const descriptors = () => traitsFor(props.selection(), availableModels());
  const open = signal(false);
  useOverlayOpen(open, "settings traits menu");
  const change = (id: string, value: string | boolean) => { const selection = props.selection(); if (selection) props.onChange(withOption(selection, descriptors(), id, value)); };
  const triggerLabel = () => buildTraitsDisplay(descriptors()).label;
  return descriptors().length === 0 ? null : (
    <View testID={`${props.label} traits`}>
      <Menu
        popupClass={MENU_POPUP_CLASS}
        onOpenChange={trackOpenChange(open)}
        trigger={
          <View
            role="button"
            accessibilityLabel={`${props.label} traits: ${triggerLabel()}`}
            class="h-7 min-w-0 max-w-48 flex-row items-center gap-1.5 rounded-lg border border-input bg-background px-[9px] hover:bg-accent dark:bg-input-32 transition-colors duration-150 ease-in-out"
          >
            <ComposerIcon name="gauge" size={16} tint={token("muted-foreground")} />
            <Text class="min-w-0 shrink truncate text-sm text-foreground">{triggerLabel()}</Text>
          </View>
        }
      >
        <Each of={descriptors()} key={(descriptor) => descriptor.id}>
          {(descriptor) => descriptor().type === "boolean" ? (
            <MenuItem accessibilityLabel={`${props.label} ${descriptor().label}`} class={MENU_ITEM_ROW_CLASS} onSelect={() => change(descriptor().id, currentValue(descriptor()) !== true)}>
              <Text class="min-w-0 flex-1 text-sm text-popover-foreground">{descriptor().label}</Text>
              {currentValue(descriptor()) === true ? <SettingsIcon name="check" size={14} tint={token("popover-foreground")} /> : null}
            </MenuItem>
          ) : (
            <>
              <Text class="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">{descriptor().label}</Text>
              {selectableChoices(descriptor() as Extract<Descriptor, { type: "select" }>).map((option) => (
                <MenuItem accessibilityLabel={`${props.label} ${descriptor().label} ${option.label}`} class={MENU_ITEM_ROW_CLASS} onSelect={() => change(descriptor().id, option.id)}>
                  <Text class="min-w-0 flex-1 truncate text-sm text-popover-foreground">{option.label}</Text>
                  {String(currentValue(descriptor()) ?? "") === option.id ? <SettingsIcon name="check" size={14} tint={token("popover-foreground")} /> : null}
                </MenuItem>
              ))}
            </>
          )}
        </Each>
      </Menu>
    </View>
  );
}
