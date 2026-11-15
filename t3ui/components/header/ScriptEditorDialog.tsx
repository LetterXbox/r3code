// The Add / Edit Action dialog (projectScriptEditor.tsx ProjectScriptEditorForm): name with an icon-picker
// button, a recorded keybinding, command, preview URL and the five option switches. Each field is a signal so
// typing re-renders only the field. Every popup registers with the occlusion registry.
import { effect, keymap, Scroll, signal, Text, View, windowSize } from "nsh";
import { Dialog, Popover } from "nsh/base";
import { DialogInput as Input } from "../DialogInput";
import { SettingsSwitch } from "../SettingsLayout";
import { contractKeyFromNsh, recordableKeystrokes } from "../../pages/settings/keybindingsLogic";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { HIcon } from "./HeaderIcons";
import { SCRIPT_ICONS, scriptFormRules, scriptValidationError, type NewProjectScriptInput } from "./projectScripts";
import { dialogBackdropStyle, dialogPopupMotion, keepPressInDialog } from "../dialogSurface";

export const SCRIPT_EDITOR_COPY = {
  add: "Add Action",
  edit: "Edit Action",
  description: "Actions are project-scoped commands you can run from the top bar or keybindings.",
  keybindingHelp: "Press a shortcut. Use Backspace to clear. Shortcuts are environment-wide. Projects using the same action share its shortcut.",
  previewHelp: "Open this URL in the in-app preview when this action runs.",
} as const;

/** The option rows, in the web's order, with the enabling rule of each. */
export const SCRIPT_OPTION_LABELS = [
  "Run automatically on worktree creation",
  "Wait for it to finish before the agent starts",
  "Run in the thread's worktree when the thread settles",
  "Stop this action when the thread settles",
  "Open preview automatically when this action runs",
] as const;

const fieldClass = "h-9 min-w-0 rounded-lg border border-input bg-background px-3 text-sm text-foreground";
const labelClass = "text-sm font-medium text-foreground";
const helpClass = "text-xs text-muted-foreground";
const optionClass = "h-9 flex-row items-center justify-between gap-3 rounded-md bg-accent-50 px-3";

export function ScriptEditorDialog(props: {
  /** The id being edited; null adds. */
  scriptId: string | null;
  initial: NewProjectScriptInput;
  saving: () => boolean;
  error: () => string | null;
  /** The connection may change keyboard shortcuts. */
  canEditKeybinding?: boolean;
  onSubmit: (input: NewProjectScriptInput) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const name = signal(props.initial.name);
  const command = signal(props.initial.command);
  const icon = signal(props.initial.icon);
  const keybinding = signal(props.initial.keybinding);
  const previewUrl = signal(props.initial.previewUrl);
  const setup = signal(props.initial.runOnWorktreeCreate);
  const wait = signal(props.initial.waitForSetup);
  const settle = signal(props.initial.runOnSettle);
  const stop = signal(props.initial.stopOnSettle);
  const autoOpen = signal(props.initial.autoOpenPreview);
  const pickerOpen = signal(false);
  const recording = signal(false);
  const localError = signal<string | null>(null);
  useOverlayOpen(() => true, "project script dialog");
  useOverlayOpen(() => pickerOpen(), "script icon picker");

  const draft = (): NewProjectScriptInput => ({
    name: name(), command: command(), icon: icon(), runOnWorktreeCreate: setup(), waitForSetup: setup() && wait(), runOnSettle: settle(), stopOnSettle: stop(),
    keybinding: keybinding(), previewUrl: previewUrl(), autoOpenPreview: previewUrl().trim().length > 0 && autoOpen(),
  });
  const rules = () => scriptFormRules({ runOnWorktreeCreate: setup(), previewUrl: previewUrl() });

  // Recording: while the field is armed every chord is a candidate; Backspace clears, Escape disarms.
  let stopRecording: (() => void) | null = null;
  function endRecording() { stopRecording?.(); stopRecording = null; recording.set(false); }
  function startRecording() {
    if (props.canEditKeybinding === false || recording()) return;
    recording.set(true);
    const removers: (() => void)[] = [];
    const bind = (keystroke: string, handler: () => void) => {
      try { removers.push(keymap.bind(keystroke, handler, { when: "always" })); } catch { /* reserved by the platform */ }
    };
    for (const chord of recordableKeystrokes()) bind(chord, () => { keybinding.set(contractKeyFromNsh(chord)); endRecording(); });
    bind("backspace", () => { keybinding.set(""); endRecording(); });
    bind("delete", () => { keybinding.set(""); endRecording(); });
    bind("escape", endRecording);
    stopRecording = () => removers.forEach((remove) => remove());
  }
  effect(() => () => endRecording());

  let pickerClosedAt = 0;
  function submit() {
    if (props.saving()) return;
    const invalid = scriptValidationError(draft());
    localError.set(invalid);
    if (!invalid) props.onSubmit(draft());
  }
  const error = () => localError() ?? props.error();
  const title = () => (props.scriptId ? SCRIPT_EDITOR_COPY.edit : SCRIPT_EDITOR_COPY.add);
  const keyShown = () => (recording() ? "Press keys..." : keybinding());

  return (
    <Dialog
      open
      animation="fade"
      closeOnEscape={!props.saving() && !pickerOpen() && !recording()}
      onOpenChange={({ open }) => {
        // Escape that closed the icon picker or the recorder must not also close the dialog.
        if (!open && !props.saving() && !pickerOpen() && !recording() && Date.now() - pickerClosedAt > 150) props.onClose();
      }}
      backdropStyle={dialogBackdropStyle()}
      style={[{ margin: "auto", width: 536, maxWidth: "94%" }, dialogPopupMotion()]}
    >
      <View class="relative min-h-0 rounded-2xl border border-border bg-background" style={{ maxHeight: Math.max(240, windowSize().height - 48) }} role="group" accessibilityLabel={title()} onPress={keepPressInDialog}>
        <View role="button" accessibilityLabel="Close" onPress={props.onClose} class="absolute right-2 top-2 z-10 size-7 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"><HIcon name="x" size={16} /></View>
        <View class="shrink-0 gap-2 p-6 pb-3">
          <Text class="text-xl font-semibold text-foreground">{title()}</Text>
          <Text class="text-sm text-muted-foreground">{SCRIPT_EDITOR_COPY.description}</Text>
        </View>
        <Scroll class="min-h-0 flex-1 gap-4 px-6 py-1">
        <View class="gap-1.5">
          <Text class={labelClass}>Name</Text>
          <View class="flex-row items-center gap-2">
            <Popover
              open={pickerOpen()}
              onOpenChange={({ open }) => { if (!open) pickerClosedAt = Date.now(); pickerOpen.set(open); }}
              popupClass="rounded-lg border border-border bg-popover-84 p-2"
              trigger={<View role="button" accessibilityLabel="Choose icon" class="size-9 shrink-0 items-center justify-center rounded-lg border border-input hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"><HIcon name={SCRIPT_ICONS.find((item) => item.id === icon())?.icon ?? "play"} size={18} /></View>}
            >
              <View class="flex-row flex-wrap gap-2" role="radiogroup" accessibilityLabel="Script icon" style={{ width: 250 }}>
                <Each of={SCRIPT_ICONS} key={(item) => item.id}>
                  {(item) => (
                    <View
                      role="radio"
                      accessibilityLabel={item().label}
                      accessibilityState={{ checked: icon() === item().id }}
                      onPress={() => { icon.set(item().id); pickerClosedAt = Date.now(); pickerOpen.set(false); }}
                      class={`w-[74px] items-center gap-2 rounded-md border px-2 py-2 ${icon() === item().id ? "border-primary bg-accent" : "border-border hover:bg-accent-50"}`}
                    >
                      <HIcon name={item().icon} size={16} />
                      <Text class="text-xs text-foreground">{item().label}</Text>
                    </View>
                  )}
                </Each>
              </View>
            </Popover>
            <Input autoFocus accessibilityLabel="Script name" value={name()} placeholder="Test" onChange={(event) => name.set(event.value)} class={`${fieldClass} flex-1`} />
          </View>
        </View>
        <View class="gap-1.5">
          <Text class={labelClass}>Keybinding</Text>
          <View
            role="button"
            accessibilityLabel="Script keybinding"
            disabled={props.canEditKeybinding === false}
            onPress={startRecording}
            class={`${fieldClass} w-full justify-center ${recording() ? "border-ring" : ""} ${props.canEditKeybinding === false ? "opacity-64" : ""}`}
          >
            <Text class={`text-sm ${keyShown() ? "text-foreground" : "text-muted-foreground"}`}>{keyShown() || "Press shortcut"}</Text>
          </View>
          <Text class={helpClass}>{SCRIPT_EDITOR_COPY.keybindingHelp}</Text>
        </View>
        <View class="gap-1.5">
          <Text class={labelClass}>Command</Text>
          <Input accessibilityLabel="Script command" value={command()} placeholder="bun test" multiline onChange={(event) => command.set(event.value)} class={`${fieldClass} h-[76px] py-2`} />
        </View>
        <View class="gap-1.5">
          <Text class={labelClass}>Preview URL (optional)</Text>
          <Input accessibilityLabel="Script preview URL" value={previewUrl()} placeholder="http://localhost:5173" onChange={(event) => previewUrl.set(event.value)} class={fieldClass} />
          <Text class={helpClass}>{SCRIPT_EDITOR_COPY.previewHelp}</Text>
        </View>
        <View class="gap-2">
          <View class={optionClass}><Text class="min-w-0 flex-1 text-sm text-foreground">{SCRIPT_OPTION_LABELS[0]}</Text><SettingsSwitch label={SCRIPT_OPTION_LABELS[0]} checked={setup()} onChange={(next) => setup.set(next)} /></View>
          <View class={`${optionClass} ${rules().waitEnabled ? "" : "opacity-60"}`}><Text class="min-w-0 flex-1 text-sm text-foreground">{SCRIPT_OPTION_LABELS[1]}</Text><SettingsSwitch label={SCRIPT_OPTION_LABELS[1]} checked={setup() && wait()} onChange={(next) => { if (rules().waitEnabled) wait.set(next); }} /></View>
          <View class={optionClass}><Text class="min-w-0 flex-1 text-sm text-foreground">{SCRIPT_OPTION_LABELS[2]}</Text><SettingsSwitch label={SCRIPT_OPTION_LABELS[2]} checked={settle()} onChange={(next) => settle.set(next)} /></View>
          <View class={optionClass}><Text class="min-w-0 flex-1 text-sm text-foreground">{SCRIPT_OPTION_LABELS[3]}</Text><SettingsSwitch label={SCRIPT_OPTION_LABELS[3]} checked={stop()} onChange={(next) => stop.set(next)} /></View>
          <View class={`${optionClass} ${rules().autoOpenEnabled ? "" : "opacity-60"}`}><Text class="min-w-0 flex-1 text-sm text-foreground">{SCRIPT_OPTION_LABELS[4]}</Text><SettingsSwitch label={SCRIPT_OPTION_LABELS[4]} checked={rules().autoOpenEnabled && autoOpen()} onChange={(next) => { if (rules().autoOpenEnabled) autoOpen.set(next); }} /></View>
        </View>
        {error() ? <Text class="text-sm text-destructive" role="alert">{error()}</Text> : null}
        </Scroll>
        <View class="shrink-0 flex-row items-center justify-end gap-2 p-6 pt-4">
          {props.scriptId ? (
            <View role="button" accessibilityLabel="Delete" disabled={props.saving()} onPress={props.onDelete} class="mr-auto h-9 items-center justify-center rounded-lg border border-destructive px-3">
              <Text class="text-sm text-destructive">Delete</Text>
            </View>
          ) : null}
          <View role="button" accessibilityLabel="Cancel" disabled={props.saving()} onPress={props.onClose} class="h-9 items-center justify-center rounded-lg border border-input px-3 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"><Text class="text-sm text-foreground">Cancel</Text></View>
          <View role="button" accessibilityLabel="Save action" disabled={props.saving()} onPress={submit} class={`h-9 items-center justify-center rounded-lg bg-primary px-3 ${props.saving() ? "opacity-64" : ""}`}>
            <Text class="text-sm font-medium text-primary-foreground">{props.saving() ? "Saving…" : props.scriptId ? "Save changes" : "Save action"}</Text>
          </View>
        </View>
      </View>
    </Dialog>
  );
}
