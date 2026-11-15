// The composer's model picker trigger (ProviderModelPicker.tsx): the provider's real mark, the model's
// name, the effort suffix (bars or the level's name, a bolt for Fast, the context window), and a popover
// (ModelPickerPopup) holding the provider sidebar, search, model rows and the docked effort column.
import { effect, signal, Text, token, untracked, View } from "nsh";
import { backendUrl, composerDraft, isLocalDraft, liveThreadProjection, openThread, supportsWorktreeBootstrap, rawProviderRecords, refreshModelCatalog, settingValue } from "../../store";
import { pickerProviderLock, startedThreadModelChangeBlock } from "../composer/pickerModel";
import { applyThreadModelPick } from "../composer/threadModelPick";
import { fanoutSelectionsFor, multipleModelLabel, setFanoutSelections, toggleFanoutModel } from "../composer/multipleModels";
import { showToast } from "../toast/toastState";
import type { AvailableModel } from "../../store";
import { ProviderIconView } from "../../pages/settings/providers/ui";
import { ComposerIcon } from "../composer/ComposerIcon";
import { EffortGlyph } from "../composer/EffortGlyph";
import { ModelPickerPopup } from "../composer/ModelPickerPopup";
import { describeEffort, ultrathinkPromptControlled, withPromptUltrathink } from "../composer/modelTraits";
import { ChatGptSharingControl } from "../composer/ChatGptSharingControl";
import { shortcutLabel } from "../../commands/registry";
import type { Descriptor } from "../composer/modelTraits";
import { createAnchor } from "../composer/Popover";
import type { Content } from "../composer/Popover";
import { providerMetaFor } from "../composer/providerCatalog";
import { modelShortName } from "../composer/modelShortName";
import { tokenAlpha } from "../composer/tokenColor";
import { Presence } from "../motion/Motion";
import { DURATION_DEFAULT_MS } from "../motion/motionTokens";

export function modelDisplayName(model: AvailableModel | null): string {
  if (!model) return "Select model";
  const separator = model.label.indexOf(": ");
  return separator >= 0 ? model.label.slice(separator + 2) : model.label;
}

/** The trigger's name: the display name without its family prefix. */
export function triggerModelName(model: AvailableModel | null): string {
  return model ? modelShortName(modelDisplayName(model), model.driver ?? providerMetaFor(model.provider)?.driver ?? null) : "Choose model";
}

/** A selected model the provider no longer offers (OpenCode and Antigravity keep the thread's pick): `selectedModel.isUnavailable`. */
export function isModelUnavailable(model: AvailableModel | null, models: readonly AvailableModel[]): boolean {
  return model !== null && models.length > 0 && !models.some((entry) => entry.provider === model.provider && entry.model === model.model);
}

/** ProviderModelPicker: a selected model the provider no longer offers reads "<name> (Unavailable)" (its tooltip and label). */
export function triggerLabelWithAvailability(model: AvailableModel | null, models: readonly AvailableModel[]): string {
  return `${triggerModelName(model)}${isModelUnavailable(model, models) ? " (Unavailable)" : ""}`;
}

/** ModelPickerContent getModelDisabledReason as ProviderModelPicker and useComposerSelection supply it. */
export function modelDisabledReason(input: { pickerDisabled: boolean; blocked: { description: string } | null }): string | null {
  if (input.pickerDisabled) return "Model picker is disabled";
  return input.blocked ? `${input.blocked.description} Start a new thread to use this model.` : null;
}

export function ModelPicker(props: {
  models: () => AvailableModel[];
  selected: () => AvailableModel | null;
  disabled: () => boolean;
  onSelect: (provider: string, model: string) => void;
  /** Lets the composer open the picker (the `/model` command). */
  open?: { (): boolean; set(value: boolean): void };
  /** Rendered under the picker panels: the interaction toggle and the Permissions menu. */
  footer?: Content;
  /** The selected model's option descriptors, with the user's picks applied. Present: the effort column docks. */
  descriptors?: () => Descriptor[];
  onTraitChange?: (id: string, value: string | boolean) => void;
}) {
  const open = props.open ?? signal(false);
  const anchor = createAnchor();
  // Every open (the trigger, /model, a shortcut) asks the server for newly released models.
  effect(() => { if (open()) untracked(refreshModelCatalog); });
  function toggle() {
    if (!openThread()?.id || props.disabled()) return;
    open.set(!open());
  }
  const meta = () => { const choice = props.selected(); return choice ? providerMetaFor(choice.provider) : null; };
  // A typed "ultrathink" controls Claude's effort: the trigger reads Ultrathink while the prompt names it.
  const effort = () => (props.descriptors ? describeEffort(withPromptUltrathink(props.descriptors(), composerDraft()), settingValue("effortDisplay") === "bars" ? "bars" : "label") : null);
  // multipleModelsEnabled: a draft on a server that bootstraps worktrees can pick several models.
  const multipleEnabled = () => { const id = openThread()?.id; return Boolean(id && isLocalDraft(id) && supportsWorktreeBootstrap()); };
  const fanout = () => (multipleEnabled() ? fanoutSelectionsFor(openThread()?.id) : null);
  const unavailable = () => !fanout() && isModelUnavailable(props.selected(), props.models());
  const label = () => { const picked = fanout(); return picked ? multipleModelLabel(picked, props.models()) : [`${modelDisplayName(props.selected())}${unavailable() ? " (Unavailable)" : ""}`, effort()?.detail].filter(Boolean).join(", "); };
  // composerProviderState modelPickerIconClassName "ultrathink-chroma": the mark is a little more saturated while the prompt names Ultrathink.
  const chroma = () => props.descriptors ? ultrathinkPromptControlled(props.descriptors(), composerDraft()) : false;
  return (
    <View class="min-w-0 shrink">
      <View
        ref={anchor.ref}
        class={`h-7 min-w-0 flex-row items-center gap-1.5 rounded-md px-2 ${open() ? "bg-accent" : "hover:bg-accent"}`}
        onPress={toggle}
        disabled={props.disabled()}
        accessibilityLabel="Select model"
        accessibilityHint={label()}
        tooltip={[label(), shortcutLabel("modelPicker.toggle")].filter(Boolean).join(" \u00b7 ")}
        role="button"
      >
        {fanout() ? (
          // Several models: up to three marks overlap, with +N for the rest.
          <View class="shrink-0 flex-row items-center" accessibilityLabel="Selected models">
            <Each of={fanout()!.slice(0, 3)} key={(entry) => `${entry.provider}:${entry.model}`}>
              {(entry, index) => {
                const instance = () => providerMetaFor(entry().provider);
                return (
                  <View class="items-center justify-center rounded-full" style={{ marginLeft: index() === 0 ? 0 : -4, backgroundColor: String(token("background")), borderWidth: 2, borderColor: String(token("background")), borderRadius: 999 }}>
                    <ProviderIconView driver={instance()?.driver ?? entry().provider} instanceId={entry().provider} name={instance()?.displayName ?? entry().provider} accentColor={instance()?.accentColor} size={16} />
                  </View>
                );
              }}
            </Each>
            {fanout()!.length > 3 ? (
              <View class="size-4 items-center justify-center rounded-full" style={{ marginLeft: -4, backgroundColor: String(token("background")), borderWidth: 2, borderColor: String(token("background")) }}>
                <Text class="text-3xs text-foreground">{`+${fanout()!.length - 3}`}</Text>
              </View>
            ) : null}
          </View>
        ) : props.selected()
          ? <View style={chroma() ? { filter: "saturate(1.2)" } : undefined}><ProviderIconView driver={meta()?.driver ?? props.selected()!.provider} instanceId={props.selected()!.provider} name={meta()?.displayName ?? props.selected()!.provider} accentColor={meta()?.accentColor} size={16} /></View>
          : <ComposerIcon name="bot" size={16} />}
        <Text class="min-w-0 max-w-56 truncate text-sm font-medium" style={{ color: tokenAlpha("foreground", 0.8) }}>{fanout() ? multipleModelLabel(fanout()!, props.models()) : triggerModelName(props.selected())}</Text>
        {unavailable() ? <View class="shrink-0 rounded-sm border border-border px-1" accessibilityLabel="Unavailable"><Text class="text-xs font-medium text-muted-foreground">Unavailable</Text></View> : null}
        {effort() && !fanout() ? (
          <View class="shrink-0 flex-row items-center gap-1.5">
            {effort()!.word ? <Text class="max-w-24 truncate text-sm text-muted-foreground">{effort()!.word}</Text> : effort()!.glyph ? <EffortGlyph count={effort()!.glyph!.count} filled={effort()!.glyph!.filled} muted /> : null}
            {effort()!.fast ? <Text class="text-xs text-muted-foreground">{effort()!.ultrafast ? "Ultrafast" : "Fast"}</Text> : null}
            {effort()!.contextWindow ? <Text class="max-w-24 truncate text-xs text-muted-foreground">{effort()!.contextWindow}</Text> : null}
          </View>
        ) : null}
      </View>
      <Presence when={open} ms={DURATION_DEFAULT_MS}>{(closing) => (
        <ModelPickerPopup
          closing={closing}
          anchor={anchor.anchor}
          models={props.models}
          selected={props.selected}
          onSelect={(provider, model) => {
            const threadId = openThread()?.id;
            const environment = backendUrl();
            if (openThread()?.id !== threadId || backendUrl() !== environment || props.disabled()) return;
            const projection = threadId ? liveThreadProjection(threadId) : null;
            const blocked = startedThreadModelChangeBlock({ projection, nextInstanceId: provider });
            if (blocked) { showToast({ type: "warning", title: blocked.title, description: blocked.description }); return; }
            // onInstanceModelChange: a plain pick ends a multiple selection.
            if (threadId && fanoutSelectionsFor(threadId)) setFanoutSelections(threadId, null);
            props.onSelect(provider, model);
            applyThreadModelPick(threadId, provider, model);
          }}
          onClose={() => open.set(false)}
          lock={() => { const id = openThread()?.id; return id ? pickerProviderLock({ projection: liveThreadProjection(id), records: rawProviderRecords() }) : null; }}
          footer={props.footer}
          disabledReason={(instanceId) => {
            const id = openThread()?.id;
            return modelDisabledReason({ pickerDisabled: props.disabled(), blocked: id ? startedThreadModelChangeBlock({ projection: liveThreadProjection(id), nextInstanceId: instanceId }) : null });
          }}
          {...(props.descriptors && !multipleEnabled() ? { listFooter: <ChatGptSharingControl provider={() => rawProviderRecords().find((record) => record.instanceId === props.selected()?.provider) ?? null} /> } : {})}
          {...(multipleEnabled() ? { multiple: {
            selected: fanout,
            toggle: (provider: string, model: string) => {
              const id = openThread()?.id;
              const current = props.selected();
              if (!id || !current) return;
              const next = toggleFanoutModel(fanoutSelectionsFor(id), { provider: current.provider, model: current.model }, provider, model);
              setFanoutSelections(id, next.selections);
              if (!next.selections) props.onSelect(next.single.provider, next.single.model);
            },
          } } : {})}
          {...(props.descriptors ? { descriptors: props.descriptors, onTraitChange: props.onTraitChange } : {})}
        />
      )}</Presence>
    </View>
  );
}
