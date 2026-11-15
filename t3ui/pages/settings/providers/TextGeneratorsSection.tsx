// TextGeneratorsSettings.tsx: model APIs that write thread titles, commit messages and other short
// text. Rows list, enable, edit and remove; the dialog is the wizard's Connect step.
import { effect, Scroll, signal, Text, View } from "nsh";
import { Dialog, Popover, Switch } from "nsh/base";
import type { AvailableModel } from "../../../store";
import { ModelPickerPopup } from "../../../components/composer/ModelPickerPopup";
import { createAnchor } from "../../../components/composer/Popover";
import type { ProviderApi } from "./data";
import { driverMeta } from "./driverMeta";
import {
  filterGeneratorModels, nextTextGeneratorId, readTextGenerators, taskSelection, TEXT_GENERATOR_PRESETS, TEXT_TASKS, textGenerationTargets, textGeneratorBrand, textGeneratorDisplayName, validBaseUrl,
  type TextGenerator, type TextGeneratorPreset, type TextTaskKey,
} from "./textGenerators";
import { ButtonText, DraftInput, ErrorText, PillButton, ProviderIconView, Row, Section, UiIcon, WizardSteps } from "./ui";
import { useOverlayOpen } from "../../../components/rightPanel/nativeOcclusion";
import { showToast } from "../../../components/toast";
import { dialogBackdropStyle, dialogPopupMotion, keepPressInDialog } from "../../../components/dialogSurface";
import { DialogCloseButton } from "../../../components/DialogCloseButton";

function errorText(cause: unknown, fallback: string): string { return cause instanceof Error && cause.message ? cause.message : fallback; }

/** One text task's model, saved as it changes, with every text generation target to pick from. */
function TaskPicker(props: { api: ProviderApi; settingKey: TextTaskKey; label: string; models: Record<string, { id: string; name: string }[]> }) {
  const generators = () => readTextGenerators(props.api.settings().textGenerators);
  const picked = () => taskSelection(props.api.settings(), props.settingKey);
  const targets = () => textGenerationTargets(props.api.providers(), generators(), props.models, [picked().selection], (driver, displayName) => displayName ?? driverMeta(driver)?.label ?? driver);
  const selectedTarget = (): AvailableModel | null => {
    const selection = picked().selection;
    if (!selection) return null;
    const found = targets().find((target) => target.provider === selection.instanceId && target.model === selection.model);
    return found ? { provider: found.provider, model: found.model, label: found.label, driver: found.driver } : { provider: selection.instanceId, model: selection.model, label: selection.model, driver: selection.instanceId };
  };
  const open = signal(false);
  const anchor = createAnchor();
  const testing = signal(false);
  const result = signal<{ key: string; error: string | null } | null>(null);
  const testKey = () => `${picked().selection?.instanceId}:${picked().selection?.model}`;
  const testable = () => { const selection = picked().selection; return selection !== null && generators().some((generator) => generator.id === selection.instanceId); };
  const shown = () => result()?.key === testKey() ? result() : null;
  async function test() {
    const selection = picked().selection;
    if (!selection) return;
    testing.set(true);
    let error: string | null = null;
    try { await props.api.listTextGeneratorModels({ id: selection.instanceId, test: true, model: selection.model }); } catch (cause) { error = errorText(cause, "The environment request failed."); }
    testing.set(false);
    result.set({ key: testKey(), error });
  }
  const display = () => { const current = selectedTarget(); if (!current) return "Select model"; const separator = current.label.indexOf(": "); return separator >= 0 ? current.label.slice(separator + 2) : current.label; };
  // In a dialog the picker lays out inline under the row (nsh-runtime-bugs.md #8: a popup there takes no presses).
  return <View class="gap-2"><View class="flex-row items-center gap-2" testID={`Text task ${props.settingKey}`}>
    <View class="min-w-0 flex-1 gap-0.5 pr-2">
      <Text class="text-sm text-foreground">{props.label}</Text>
      {shown()?.error ? <Text role="alert" class="text-xs text-destructive-foreground">{shown()?.error}</Text>
        : shown() ? <Text class="text-xs text-muted-foreground">{`${picked().selection?.model} answered. It works.`}</Text>
        : picked().own === null ? <Text class="text-xs text-muted-foreground">Follows the text generation model</Text> : null}
    </View>
    <View class="shrink-0">
      <View ref={anchor.ref} accessibilityLabel={`${props.label} model`} role="button" onPress={() => open.set(!open())}
        class="h-8 min-w-0 max-w-56 flex-row items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 hover:bg-accent-50 transition-colors duration-150 ease-in-out">
        {selectedTarget() ? <ProviderIconView driver={selectedTarget()?.driver ?? ""} name={selectedTarget()?.label ?? ""} size={20} /> : null}
        <Text class="min-w-0 shrink truncate text-sm text-foreground">{display()}</Text>
        <UiIcon name="chevron-down" size={14} />
      </View>
    </View>
    <View class="w-14 shrink-0 items-end">
      {testable() ? <PillButton label={`Test ${props.label}`} size="xs" disabled={testing()} onPress={() => void test()}><ButtonText>{testing() ? "Testing" : "Test"}</ButtonText></PillButton> : null}
    </View>
  </View>
    {open() ? <ModelPickerPopup inline anchor={anchor.anchor} models={() => targets().map((target) => ({ provider: target.provider, model: target.model, label: target.label, driver: target.driver }))} selected={selectedTarget} onClose={() => open.set(false)}
        onSelect={(provider, model) => { void props.api.updateSettings({ [props.settingKey]: { instanceId: provider, model } }); }} /> : null}
  </View>;
}

/** Searchable models; a search field only shows past eight. */
function ModelList(props: { models: { id: string; name: string }[] }) {
  const query = signal("");
  const shown = () => filterGeneratorModels(props.models, query());
  return <View class="gap-2">
    {props.models.length > 8 ? <DraftInput label="Search models" value={query()} placeholder="Search models" class="w-full" onCommit={(next) => query.set(next)} /> : null}
    <View class="max-h-80 overflow-hidden rounded-lg border border-border-60">
      {shown().length === 0 ? <View class="px-3 py-2"><Text class="text-sm text-muted-foreground">No models match.</Text></View> : <Scroll class="max-h-80">
        <Each of={shown()} key={(model) => model.id}>{(model, index) => <View class={`flex-row items-center gap-2 px-3 py-2 ${index() > 0 ? "border-t border-border-60" : ""}`}>
          <View class="min-w-0 flex-1"><Text class="truncate text-sm text-foreground">{model().name}</Text>{model().name !== model().id ? <Text class="truncate font-mono text-xs text-muted-foreground">{model().id}</Text> : null}</View>
        </View>}</Each>
      </Scroll>}
    </View>
  </View>;
}

/** A saved generator's models, with a refresh that asks the API again. */
function ModelsDialog(props: { api: ProviderApi; generator: TextGenerator; onClose: () => void }) {
  useOverlayOpen(true, "text generator models");
  const name = () => textGeneratorDisplayName(props.generator);
  const models = signal<{ id: string; name: string }[] | null>(null);
  const error = signal<string | null>(null);
  const refreshing = signal(false);
  async function load(refresh: boolean) {
    refreshing.set(refresh); error.set(null);
    try { models.set((await props.api.listTextGeneratorModels({ id: props.generator.id, ...(refresh ? { refresh: true } : {}) })).models); }
    // refreshTextGeneratorModels: a failed refresh is a toast and the list on screen stays; only the first load shows the error inline.
    catch (cause) { const message = errorText(cause, "The environment request failed."); if (refresh) showToast({ type: "error", title: `Couldn't load ${name()} models`, description: message }); if (models() === null) error.set(message); }
    finally { refreshing.set(false); }
  }
  void load(false);
  const count = () => models()?.length ?? 0;
  return <Dialog open animation="fade" onCancel={props.onClose} onOpenChange={({ open }) => { if (!open) props.onClose(); }} testID="Text generator models dialog"
    backdropStyle={dialogBackdropStyle()} style={[{ margin: "auto", width: 448, maxWidth: "92%" }, dialogPopupMotion()]}>
    <View class="relative w-full flex-col overflow-hidden rounded-2xl border border-border bg-background" onPress={keepPressInDialog}>
      <DialogCloseButton onClose={props.onClose} />
      <View class="gap-1 px-6 pt-6 pb-4">
        <Text class="text-lg font-semibold text-foreground">{`${name()} models`}</Text>
        <Text class="text-sm text-muted-foreground">{models() === null ? (error() ? "The model list couldn't load." : "Loading the model list.") : `${count()} ${count() === 1 ? "model" : "models"} available. Pick one in a text generation model picker.`}</Text>
      </View>
      <View class="px-6 pb-4">
        {error() ? <Text role="alert" class="text-sm text-destructive-foreground">{error()}</Text> : models() === null ? <UiIcon name="loader-circle" size={16} /> : <ModelList models={models() as { id: string; name: string }[]} />}
      </View>
      <View class="flex-row items-center justify-end gap-2 px-6 pb-6">
        <PillButton label="Refresh models" disabled={refreshing()} onPress={() => void load(true)}><UiIcon name="refresh-cw" size={14} /><ButtonText>Refresh</ButtonText></PillButton>
        <PillButton label="Done" variant="primary" onPress={props.onClose}><ButtonText tone="primary">Done</ButtonText></PillButton>
      </View>
    </View>
  </Dialog>;
}

const STEPS = ["Connect", "Use it"] as const;

/**
 * Connect checks the settings by listing the service's models and saves the generator; Use it then shows each text
 * task's model picker, so any of them can switch to it.
 */
function GeneratorDialog(props: { api: ProviderApi; editing: TextGenerator | "new"; taken: string[]; onClose: () => void }) {
  useOverlayOpen(true, "text generator");
  const existing = props.editing === "new" ? null : props.editing;
  const step = signal(0);
  const preset = signal<TextGeneratorPreset>(TEXT_GENERATOR_PRESETS[0] as TextGeneratorPreset);
  const baseUrl = signal(existing?.baseUrl ?? (TEXT_GENERATOR_PRESETS[0]?.baseUrl ?? ""));
  const label = signal(existing?.label ?? "");
  const apiKey = signal("");
  const checking = signal(false);
  const checkError = signal<string | null>(null);
  const modelCount = signal(0);
  const savedId = signal<string | null>(existing?.id ?? null);
  const models = signal<Record<string, { id: string; name: string }[]>>({});
  const storedKey = typeof existing?.apiKey === "string" ? existing.apiKey : "";
  const keyRequired = () => existing === null && preset().id !== "custom";
  // Presets know their URL; only a custom endpoint, or one already saved as such, asks for it.
  const showBaseUrl = () => existing === null ? preset().id === "custom" : !["openai", "anthropic", "openrouter"].includes(textGeneratorBrand(existing));
  const kind = () => existing?.kind ?? preset().kind;
  const effectiveKey = () => apiKey().trim() || storedKey;
  const canConnect = () => validBaseUrl(baseUrl()) && (!keyRequired() || effectiveKey() !== "") && !checking();
  const config = () => ({ kind: kind(), ...(label().trim() ? { label: label().trim() } : {}), baseUrl: baseUrl().trim(), apiKey: effectiveKey(), enabled: existing?.enabled ?? true });
  const name = () => textGeneratorDisplayName({ kind: kind(), baseUrl: baseUrl().trim(), ...(label().trim() ? { label: label().trim() } : {}) }) || preset().label;
  const generators = () => readTextGenerators(props.api.settings().textGenerators);

  async function connect() {
    if (!canConnect()) return;
    const id = savedId() ?? nextTextGeneratorId(preset().id, props.taken);
    checking.set(true); checkError.set(null);
    let listed: { id: string; name: string }[];
    try { listed = (await props.api.listTextGeneratorModels({ id, config: config() })).models; }
    catch (cause) { checkError.set(errorText(cause, "The environment request failed.")); checking.set(false); return; }
    try { await props.api.updateSettings({ textGenerators: { [id]: config() } }); }
    catch (cause) { checkError.set(errorText(cause, "Could not save the text generator.")); checking.set(false); return; }
    checking.set(false);
    savedId.set(id); modelCount.set(listed.length); models.update((all) => ({ ...all, [id]: listed })); step.set(1);
  }
  // Every enabled generator's list backs the pickers.
  effect(() => {
    if (step() !== 1) return;
    for (const generator of generators().filter((item) => item.enabled)) {
      if (models()[generator.id]) continue;
      void props.api.listTextGeneratorModels({ id: generator.id }).then((result) => models.update((all) => ({ ...all, [generator.id]: result.models }))).catch(() => {});
    }
  });
  return <Dialog open animation="fade" onCancel={props.onClose} onOpenChange={({ open }) => { if (!open) props.onClose(); }} closeOnBackdropPress={false} testID="Text generator dialog"
    backdropStyle={dialogBackdropStyle()} style={[{ margin: "auto", width: 576, maxWidth: "92%" }, dialogPopupMotion()]}>
    <View class="relative w-full flex-col overflow-hidden rounded-2xl border border-border bg-background" onPress={keepPressInDialog}>
      <DialogCloseButton onClose={props.onClose} />
      <View class="gap-1 px-6 pt-6 pb-4">
        <Text class="text-lg font-semibold text-foreground">{existing ? `Edit ${textGeneratorDisplayName(existing)}` : "Add a text generator"}</Text>
        <Text class="text-sm text-muted-foreground">Writes thread titles, commit messages, and other short text without starting a coding agent. Your API key is stored on this environment.</Text>
        <View class="mt-3"><WizardSteps steps={STEPS} current={step()} isDisabled={(index) => index > step()} onChange={(index) => step.set(index)} /></View>
      </View>
      <View class="gap-4 bg-background px-6 py-5">
        {step() === 0 ? <View class="gap-4" style={{ opacity: checking() ? 0.64 : 1 }}>
          {existing === null ? <View class="gap-1.5">
            <Text class="text-sm font-medium text-foreground">Service</Text>
            <View accessibilityLabel="Service" role="radiogroup" class="flex-row flex-wrap gap-2">
              <Each of={TEXT_GENERATOR_PRESETS} key={(item) => item.id}>{(item) => <View accessibilityLabel={`Preset ${item().label}`} role="radio" accessibilityState={{ checked: preset().id === item().id, disabled: checking() }}
                onPress={() => { if (checking()) return; preset.set(item()); baseUrl.set(item().baseUrl); checkError.set(null); }}
                class={`w-[120px] items-center gap-2 rounded-lg border px-2 py-3 ${preset().id === item().id ? "border-primary bg-accent-50" : "border-border bg-background hover:bg-accent-50"}`}>
                {item().id === "custom" ? <UiIcon name="server" size={20} tone={preset().id === "custom" ? "foreground" : "muted"} /> : <ProviderIconView driver={textGeneratorBrand(item())} name={item().label} size={20} />}
                <Text class={`text-sm ${preset().id === item().id ? "font-medium text-foreground" : "text-muted-foreground"}`}>{item().id === "custom" ? "Custom" : item().label}</Text>
              </View>}</Each>
            </View>
          </View> : null}
          {showBaseUrl() ? <View class="gap-1.5"><Text class="text-sm font-medium text-foreground">Base URL</Text>
            <DraftInput label="Base URL" mono value={baseUrl()} placeholder="http://localhost:11434/v1" disabled={checking()} class="w-full" onCommit={(next) => { baseUrl.set(next); checkError.set(null); }} /></View> : null}
          <View class="gap-1.5"><Text class="text-sm font-medium text-foreground">{keyRequired() ? "API key" : "API key (optional)"}</Text>
            <DraftInput label="API key" masked value={apiKey()} disabled={checking()} placeholder={storedKey !== "" ? "Stored secret, enter a new value to replace" : ""} class="w-full" onCommit={(next) => { apiKey.set(next); checkError.set(null); }} /></View>
          <View class="gap-1.5"><Text class="text-sm font-medium text-foreground">Name (optional)</Text>
            <DraftInput label="Name" value={label()} disabled={checking()} placeholder={existing !== null ? textGeneratorDisplayName(existing) : preset().id === "custom" ? "e.g. My local model" : preset().label} class="w-full" onCommit={(next) => label.set(next)} /></View>
          {checkError() ? <Text role="alert" class="text-sm text-destructive-foreground">{checkError()}</Text> : null}
        </View> : <View class="gap-4">
          <Text class="text-sm text-muted-foreground">{`${name()} is connected and lists ${modelCount()} ${modelCount() === 1 ? "model" : "models"}. Switch any of these to it, or keep what they use now.`}</Text>
          <View class="gap-4">
            <Each of={TEXT_TASKS} key={(task) => task.key}>{(task) => <TaskPicker api={props.api} settingKey={task().key} label={task().label} models={models()} />}</Each>
          </View>
        </View>}
      </View>
      <View class="flex-row items-center justify-between gap-2 px-6 py-4">
        <View>{step() > 0 ? <PillButton label="Back" variant="ghost" onPress={() => step.set(0)}><ButtonText>Back</ButtonText></PillButton> : null}</View>
        <View class="flex-row items-center gap-2">
          {step() === 0 ? <>
            <PillButton label="Cancel text generator" onPress={props.onClose}><ButtonText>Cancel</ButtonText></PillButton>
            <PillButton label="Connect text generator" variant="primary" disabled={!canConnect()} onPress={() => void connect()}><ButtonText tone="primary">{checking() ? "Connecting" : existing ? "Save and continue" : "Connect"}</ButtonText></PillButton>
          </> : <PillButton label="Done" variant="primary" onPress={props.onClose}><ButtonText tone="primary">Done</ButtonText></PillButton>}
        </View>
      </View>
    </View>
  </Dialog>;
}

function RemoveDialog(props: { name: string; environmentLabel: string; onConfirm: () => void; onClose: () => void }) {
  useOverlayOpen(true, "remove text generator");
  return <Dialog open animation="fade" onCancel={props.onClose} onOpenChange={({ open }) => { if (!open) props.onClose(); }} testID="Remove text generator dialog"
    backdropStyle={dialogBackdropStyle()} style={[{ margin: "auto", width: 448, maxWidth: "92%" }, dialogPopupMotion()]}>
    <View class="w-full flex-col gap-4 overflow-hidden rounded-2xl border border-border bg-background px-6 py-5" onPress={keepPressInDialog}>
      <View class="gap-1">
        <Text class="text-lg font-semibold text-foreground">{`Remove ${props.name}?`}</Text>
        <Text class="text-sm text-muted-foreground">{`This deletes the API key stored on ${props.environmentLabel}. Anything set to use this generator falls back to the text generation model.`}</Text>
      </View>
      <View class="flex-row items-center justify-end gap-2">
        <PillButton label="Cancel remove text generator" onPress={props.onClose}><ButtonText>Cancel</ButtonText></PillButton>
        <PillButton label="Confirm remove text generator" onPress={props.onConfirm}><ButtonText tone="destructive">Remove</ButtonText></PillButton>
      </View>
    </View>
  </Dialog>;
}

function GeneratorMenu(props: { name: string; canShow: boolean; onEdit: () => void; onShow: () => void; onRemove: () => void }) {
  const open = signal(false);
  useOverlayOpen(() => open(), "text generator menu");
  const item = (label: string, action: () => void, destructive?: boolean, disabled?: boolean) => <View accessibilityLabel={label} role="button" disabled={disabled === true} onPress={() => { if (disabled) return; open.set(false); action(); }} class={`h-8 justify-center rounded-md px-2 hover:bg-accent-50 ${disabled ? "opacity-64" : ""}`}>
    <Text class={destructive ? "text-sm text-destructive-foreground" : "text-sm text-foreground"}>{label}</Text></View>;
  return <Popover open={open()} onOpenChange={(event) => open.set(event.open)} placement="bottom" align="end" offset={6} popupClass="w-40 gap-0.5 rounded-lg border border-border bg-popover-84 p-1"
    trigger={<View accessibilityLabel={`More actions for ${props.name}`} role="button" class="size-7 items-center justify-center rounded-md hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out"><UiIcon name="more-vertical" size={16} /></View>}>
    <View class="gap-0.5">{item("Edit", props.onEdit)}{item("Show models", props.onShow, false, !props.canShow)}{item("Remove", props.onRemove, true)}</View>
  </Popover>;
}

/** The Text generators section. */
export function TextGenerators(props: { api: ProviderApi; environmentLabel: string; readOnly: boolean }) {
  const editing = signal<TextGenerator | "new" | null>(null);
  const removing = signal<TextGenerator | null>(null);
  const viewing = signal<TextGenerator | null>(null);
  const error = signal("");
  const generators = () => readTextGenerators(props.api.settings().textGenerators);
  const taken = () => [...Object.keys(props.api.instances()), ...props.api.providers().map((provider) => provider.instanceId), ...generators().map((item) => item.id)];
  async function write(patch: Record<string, unknown>) {
    error.set("");
    try { await props.api.updateSettings({ textGenerators: patch }); } catch (cause) { error.set(errorText(cause, "Could not update the text generator.")); }
  }
  return <>
    <Section title="Text generators"
      action={!props.readOnly ? <PillButton label="Add generator" size="xs" onPress={() => editing.set("new")}><UiIcon name="plus" size={12} /><ButtonText>Add generator</ButtonText></PillButton> : null}>
      {generators().length === 0 ? <Row divider={false} title="No text generators yet" description="Add a model API to write thread titles, commit messages, and other short text without starting a coding agent." /> : null}
      <Each of={generators()} key={(item) => item.id}>{(item, index) => {
        const name = () => textGeneratorDisplayName(item());
        return <Row divider={index() > 0} testID={`Text generator ${item().id}`}
          title={<View class="flex-row items-center gap-2.5"><ProviderIconView driver={textGeneratorBrand(item())} name={name()} size={20} /><Text class="text-sm font-medium text-foreground">{name()}</Text></View>}
          description={<Text class="pl-[30px] text-xs leading-normal text-muted-foreground truncate">{`${item().enabled ? "" : "Off · "}${item().baseUrl.replace(/^https?:\/\//, "")}`}</Text>}
          control={!props.readOnly ? <View class="flex-row items-center gap-2">
            <GeneratorMenu name={name()} canShow={item().enabled} onEdit={() => editing.set(item())} onShow={() => viewing.set(item())} onRemove={() => removing.set(item())} />
            <Switch checked={item().enabled} onChange={(event: { checked?: boolean }) => void write({ [item().id]: { kind: item().kind, ...(item().label ? { label: item().label } : {}), baseUrl: item().baseUrl, apiKey: item().apiKey, enabled: event.checked === true } })}
              accessibilityLabel={`Enable ${name()}`} testID={`${name()} generator ${item().enabled ? "on" : "off"}`}
              class="h-[18px] w-[30px] items-center" trackClass="h-[18px] w-[30px] justify-center rounded-full bg-input checked:bg-primary transition-colors duration-200 ease-in-out" thumbClass="size-3.5 rounded-full bg-background checked:translate-x-3 transition-transform duration-150 ease-in-out" />
          </View> : null} />;
      }}</Each>
      {error() ? <View class="px-4 pb-3"><ErrorText>{error()}</ErrorText></View> : null}
    </Section>
    {editing() !== null && !props.readOnly ? <GeneratorDialog api={props.api} editing={editing() as TextGenerator | "new"} taken={taken()} onClose={() => editing.set(null)} /> : null}
    {viewing() ? <ModelsDialog api={props.api} generator={viewing() as TextGenerator} onClose={() => viewing.set(null)} /> : null}
    {removing() ? <RemoveDialog name={textGeneratorDisplayName(removing() as TextGenerator)} environmentLabel={props.environmentLabel} onClose={() => removing.set(null)}
      onConfirm={() => { const target = removing(); removing.set(null); if (target) void write({ [target.id]: null }); }} /> : null}
  </>;
}
