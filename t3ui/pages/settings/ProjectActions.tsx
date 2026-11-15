// ProjectActionsSettings.tsx and ProjectActionsList.tsx: the Actions card of a project. Actions are the project's
// `defaultProjectScripts` override; Add action and each row's gear open the Add / Edit Action dialog, and a
// shortcut is saved as a keybinding of the action's command.
import { signal, Text, View } from "nsh";
import { SettingsButton, SettingsRow, SettingsSection } from "../../components/SettingsLayout";
import { HIcon } from "../../components/header/HeaderIcons";
import { ScriptEditorDialog } from "../../components/header/ScriptEditorDialog";
import { keybindingCalls, keybindingValueForCommand } from "../../components/header/scriptKeybindings";
import { resolveProjectScripts, projectScriptsPatch } from "../../components/header/scriptSettings";
import {
  EMPTY_PROJECT_SCRIPT_INPUT, SCRIPT_ICONS, commandForProjectScript, deleteScript, inputFromScript, saveScript, savedScriptId, scriptValidationError,
  type NewProjectScriptInput, type ProjectScript,
} from "../../components/header/projectScripts";
import { confirm, showToast } from "../../components/toast";
import { settingsWriteDenied } from "./settingsWriteAccess";
import { useOverlayOpen } from "../../components/rightPanel/nativeOcclusion";
import type { Project } from "../../store";
import { InheritanceMark } from "./InheritanceMark";
import { projectFileInvalid, projectFileOf } from "./scopeState";
import { readProjectScripts } from "../../components/header/projectScripts";
import { replaceServerKeybindings, replaceServerSettings, serverKeybindings, serverSettings } from "./settingsState";
import { isServerConnected, requestServer } from "./settingsSync";
import { SettingsIcon } from "./SettingsIcon";
import { createHover } from "../../components/hoverReveal";

const iconFor = (id: string) => SCRIPT_ICONS.find((item) => item.id === id)?.icon ?? "play";

function Badge(props: { text: string }) {
  return <View class="shrink-0 rounded-sm border border-border-60 px-1.5 py-px"><Text class="text-2xs font-normal text-muted-foreground">{props.text}</Text></View>;
}

export function ProjectActions(props: { project: () => Project }) {
  const editor = signal<{ scriptId: string | null; initial: NewProjectScriptInput } | null>(null);
  const saving = signal(false);
  const formError = signal<string | null>(null);
  useOverlayOpen(() => editor() !== null, "project actions dialog");
  const scripts = (): ProjectScript[] => [...resolveProjectScripts(serverSettings(), { id: props.project().id, scripts: (props.project().scripts ?? []) as ProjectScript[] })];
  const shortcut = (script: ProjectScript) => keybindingValueForCommand(serverKeybindings() as Record<string, unknown>[], commandForProjectScript(script.id));
  const disabled = () => saving() || !isServerConnected();

  const persist = async (next: ProjectScript[] | null): Promise<boolean> => {
    // useProjectScriptSettings.persist: one change at a time, on a reachable machine, with settings:write.
    if (saving() || !isServerConnected()) {
      showToast({ type: "error", title: "Actions not saved", description: "No available machine, or another action change is saving." });
      return false;
    }
    if (settingsWriteDenied()) {
      showToast({ type: "error", title: "Failed to save project actions", description: "This connection cannot change environment settings." });
      return false;
    }
    saving.set(true);
    formError.set(null);
    try {
      replaceServerSettings(await requestServer("server.updateSettings", { patch: projectScriptsPatch(serverSettings(), props.project().id, next) }));
      return true;
    } catch (cause) {
      showToast({ type: "error", title: "Failed to save project actions", description: cause instanceof Error && cause.message ? cause.message : "An error occurred." });
      return false;
    } finally {
      saving.set(false);
    }
  };
  const applyKeybinding = async (command: string | null, key: string | null): Promise<boolean> => {
    if (command === null) return true;
    try {
      let result: unknown = null;
      for (const call of keybindingCalls(serverKeybindings() as Record<string, unknown>[], command, key)) result = await requestServer(call.method, call.payload);
      const next = (result as { keybindings?: unknown } | null)?.keybindings;
      if (next !== undefined) replaceServerKeybindings(next);
      return true;
    } catch (cause) {
      // reportScriptFailure: the failed shortcut write is a toast, and the form shows the server's own text.
      const message = cause instanceof Error && cause.message ? cause.message : null;
      showToast({ type: "error", title: "Failed to save project actions", description: message ?? "An error occurred." });
      formError.set(message ?? "Failed to save action.");
      return false;
    }
  };
  /** Actions t3.json declares that the project does not have yet (importableScripts). */
  const importable = (): ProjectScript[] => {
    const declared = readProjectScripts(projectFileOf(props.project().id)?.scripts ?? []);
    return declared.filter((file) => !scripts().some((script) => script.command === file.command || script.name.toLowerCase() === file.name.toLowerCase()));
  };
  const importScript = async (file: ProjectScript) => {
    const input: NewProjectScriptInput = { ...inputFromScript(file, null), keybinding: "" };
    if (await persist(saveScript(scripts(), null, input))) return;
    formError.set("Failed to import action.");
  };
  const openAdd = () => { formError.set(null); editor.set({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT }); };
  const openEdit = (script: ProjectScript) => { formError.set(null); editor.set({ scriptId: script.id, initial: inputFromScript(script, shortcut(script)) }); };
  const submit = async (input: NewProjectScriptInput) => {
    const current = editor();
    if (!current || saving()) return;
    const invalid = scriptValidationError(input);
    if (invalid) { formError.set(invalid); return; }
    const id = savedScriptId(scripts(), current.scriptId, input);
    const changesKey = (input.keybinding.trim() || null) !== (current.initial.keybinding.trim() || null);
    if (!(await persist(saveScript(scripts(), current.scriptId, input)))) return;
    if (changesKey && !(await applyKeybinding(commandForProjectScript(id), input.keybinding))) return;
    editor.set(null);
  };
  const remove = async () => {
    const script = scripts().find((candidate) => candidate.id === editor()?.scriptId);
    if (!script) return;
    if (!(await confirm(`Delete action "${script.name}"?\nThis action cannot be undone.`, { variant: "destructive" }))) return;
    if (await persist(deleteScript(scripts(), script.id))) { await applyKeybinding(commandForProjectScript(script.id), null); editor.set(null); }
  };

  return (
    <SettingsSection title="Actions">
      <SettingsRow
        title="Actions"
        description="Commands that run in this project's checkout or its worktree, with optional shortcuts."
        inheritance={(rowHovered: () => boolean) => <InheritanceMark title="Actions" keys={["defaultProjectScripts"]} rowHovered={rowHovered} />}
        control={<SettingsButton label="Add action" disabled={disabled()} onPress={openAdd} />}
      />
      {scripts().length === 0 ? (
        <View class="border-t border-border-50 px-4 py-2"><Text class="text-sm text-muted-foreground">No actions configured.</Text></View>
      ) : null}
      <Each of={scripts()} key={(script) => script.id}>
        {(script) => {
          // ProjectActionsList: the edit button is `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`.
          const hover = createHover();
          return (
          <View {...hover.bind} class="border-t border-border-50" testID={`Action ${script().name}`}>
            <SettingsRow
              title={script().name}
              titleNode={
                <View class="min-w-0 flex-row items-center gap-2">
                  <HIcon name={iconFor(script().icon)} size={16} />
                  <Text class="min-w-0 truncate text-sm font-medium text-foreground">{script().name}</Text>
                  {script().runOnWorktreeCreate ? <Badge text="setup" /> : null}
                  {script().runOnSettle ? <Badge text="on settle" /> : null}
                  {script().previewUrl ? <Badge text="preview · desktop only" /> : null}
                </View>
              }
              description={script().command}
              control={
                <View class="flex-row items-center gap-2">
                  {shortcut(script()) ? <Text class="text-xs text-muted-foreground">{shortcut(script())!}</Text> : null}
                  <View role="button" accessibilityLabel={`Edit ${script().name}`} disabled={disabled()} onPress={() => openEdit(script())} {...hover.trackFocus} class={`size-6 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out ${hover.hovered() ? "" : "opacity-0"}`}>
                    <SettingsIcon name="settings" size={14} />
                  </View>
                </View>
              }
            />
          </View>
          );
        }}
      </Each>
      {importable().length > 0 ? (
        <View class="border-t border-border-50 px-4 py-2 gap-1">
          <Text class="text-xs text-muted-foreground">Import from t3.json</Text>
          <Each of={importable()} key={(script) => `${script.name} ${script.command}`}>
            {(script) => (
              <View role="button" accessibilityLabel={`Import ${script().name}`} onPress={() => void importScript(script())} class="flex-row items-center gap-2 rounded-md px-1 py-1 hover:bg-accent">
                <HIcon name={iconFor(script().icon)} size={16} />
                <Text class="min-w-0 flex-1 truncate text-sm text-foreground">{script().name}</Text>
                <Text class="truncate font-mono text-xs text-muted-foreground">{script().command}</Text>
              </View>
            )}
          </Each>
        </View>
      ) : null}
      {projectFileInvalid(props.project().id) ? (
        <SettingsRow title="t3.json is invalid" description="A t3.json exists in this checkout but fails to parse, so every action and icon it declares is ignored. Check the JSON syntax and icon values." />
      ) : null}
      {editor() !== null ? (
        <ScriptEditorDialog
          scriptId={editor()?.scriptId ?? null}
          initial={editor()?.initial ?? EMPTY_PROJECT_SCRIPT_INPUT}
          saving={saving}
          error={formError}
          onSubmit={(input) => { void submit(input); }}
          onDelete={() => void remove()}
          onClose={() => { if (!saving()) editor.set(null); }}
        />
      ) : null}
    </SettingsSection>
  );
}
