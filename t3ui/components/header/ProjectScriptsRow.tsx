// ProjectScriptsControl.tsx in its `panel` display mode: with scripts, a split row
// ("Run <primary>" and a chevron menu listing every script, each with an edit
// gear, then "Add project script"); without, a single "Add project script" row.
// The add / edit dialog is projectScriptEditor.tsx's (ScriptEditorDialog.tsx).
import { effect, signal, Text, View } from "nsh";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { Menu, MenuItem, MenuSeparator, Tooltip } from "nsh/base";
import { confirm, showToast } from "../toast";
import { replaceServerKeybindings, serverKeybindings } from "../../pages/settings/settingsState";
import { requestServer } from "../../pages/settings/settingsSync";
import { HIcon } from "./HeaderIcons";
import {
  EMPTY_PROJECT_SCRIPT_INPUT, SCRIPT_ICONS, commandForProjectScript, deleteScript, inputFromScript, primaryProjectScript, projectScriptMenuLabel, saveScript, savedScriptId, scriptValidationError,
  type NewProjectScriptInput, type ProjectScript,
} from "./projectScripts";
import { keybindingCalls, keybindingValueForCommand } from "./scriptKeybindings";
import { ScriptEditorDialog } from "./ScriptEditorDialog";
import { importableScripts, importInput, type T3ProjectFileScript } from "./t3ProjectFile";
import { MENU_ITEM_ROW_CLASS, MENU_POPUP_CLASS } from "../menuStyles";

const rowClass = "h-8 w-full flex-row items-center gap-2.5 rounded-lg px-2.5 hover:bg-accent";
const labelClass = "min-w-0 flex-1 truncate text-[13px] font-medium text-foreground";
const menuClass = MENU_POPUP_CLASS;
const itemClass = MENU_ITEM_ROW_CLASS;

const iconFor = (id: string) => SCRIPT_ICONS.find((item) => item.id === id)?.icon ?? "play";

function Tip(props: { text: string }) {
  return <Tooltip class="max-w-80 rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">{props.text}</Text></Tooltip>;
}

export interface ProjectScriptsRowProps {
  scripts: () => ProjectScript[];
  /** The script last run in this project (lastInvokedScriptByProjectId). */
  preferredScriptId?: () => string | null;
  onRun?: (script: ProjectScript) => void;
  /** Persists the whole list; rejects with the server's message. */
  onSave: (scripts: ProjectScript[]) => Promise<void>;
  /** The scripts of the project's t3.json (useT3ProjectFileScripts); the ones the project lacks are offered under "From t3.json". */
  fileScripts?: () => readonly T3ProjectFileScript[];
  /** A dialog of the row opened or closed. */
  onDialogChange?: (open: boolean) => void;
  /** server.upsertKeybinding / removeKeybinding; the connected server by default. */
  requestServer?: (method: string, payload: unknown) => Promise<unknown>;
}

export function ProjectScriptsRow(props: ProjectScriptsRowProps) {
  const editor = signal<{ scriptId: string | null; initial: NewProjectScriptInput } | null>(null);
  const formError = signal<string | null>(null);
  const saving = signal(false);
  useOverlayOpen(() => editor() !== null, "project script dialog");
  let reported = false;
  effect(() => {
    const isOpen = editor() !== null;
    if (isOpen !== reported) { reported = isOpen; props.onDialogChange?.(isOpen); }
  });
  // ProjectScriptsControl: the script last run in this project leads, else the first regular one.
  const primary = () => { const preferred = props.preferredScriptId?.() ?? null; return (preferred ? props.scripts().find((script) => script.id === preferred) : undefined) ?? primaryProjectScript(props.scripts()); };
  const importable = () => importableScripts(props.fileScripts?.() ?? [], props.scripts());
  const runnable = () => props.onRun !== undefined;

  const currentKey = (command: string | null) => keybindingValueForCommand(serverKeybindings() as Record<string, unknown>[], command);
  function openAdd() { formError.set(null); editor.set({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT }); }
  function openEdit(script: ProjectScript) {
    formError.set(null);
    editor.set({ scriptId: script.id, initial: inputFromScript(script, currentKey(commandForProjectScript(script.id))) });
  }

  async function persist(next: ProjectScript[]): Promise<boolean> {
    saving.set(true);
    formError.set(null);
    try { await props.onSave(next); return true; }
    catch (cause) { formError.set(cause instanceof Error ? cause.message : "Failed to save action."); return false; }
    finally { saving.set(false); }
  }
  /** Scripts first, then the shortcut (useProjectScriptEditing.ts persistProjectScripts). */
  async function applyKeybinding(command: string | null, key: string | null): Promise<boolean> {
    if (command === null) return true;
    const calls = keybindingCalls(serverKeybindings() as Record<string, unknown>[], command, key);
    try {
      let result: unknown = null;
      for (const call of calls) result = await (props.requestServer ?? requestServer)(call.method, call.payload);
      const next = (result as { keybindings?: unknown } | null)?.keybindings;
      if (next !== undefined) replaceServerKeybindings(next);
      return true;
    } catch (cause) {
      // useProjectScriptEditing: the failed shortcut write is the save's failure, shown as the server's own text.
      formError.set(cause instanceof Error && cause.message ? cause.message : "Failed to save action.");
      return false;
    }
  }
  /** importFileScript: saves the file's script as the project's own; a refusal opens the form with the server's reason. */
  async function importFileScript(file: T3ProjectFileScript) {
    if (saving()) return;
    const payload = importInput(file);
    if (await persist(saveScript(props.scripts(), null, payload))) return;
    const reason = formError();
    editor.set({ scriptId: null, initial: payload });
    formError.set(reason ?? "Failed to import action.");
  }
  async function submit(input: NewProjectScriptInput) {
    const current = editor();
    if (!current || saving()) return;
    const invalid = scriptValidationError(input);
    if (invalid) { formError.set(invalid); return; }
    const id = savedScriptId(props.scripts(), current.scriptId, input);
    const command = commandForProjectScript(id);
    const changesKey = (input.keybinding.trim() || null) !== (current.initial.keybinding.trim() || null);
    if (!(await persist(saveScript(props.scripts(), current.scriptId, input)))) return;
    if (changesKey && !(await applyKeybinding(command, input.keybinding))) return;
    editor.set(null);
  }
  /** projectScriptEditor.tsx's AlertDialog: "Delete action "X"?" with its warning, through the shared confirmation. */
  async function confirmRemove(script: ProjectScript | undefined) {
    if (!script) return;
    if (await confirm(`Delete action "${script.name}"?\nThis action cannot be undone.`, { variant: "destructive" })) await remove(script);
  }
  async function remove(script: ProjectScript) {
    if (await persist(deleteScript(props.scripts(), script.id))) {
      await applyKeybinding(commandForProjectScript(script.id), null);
      editor.set(null);
      // useProjectScriptEditing deleteProjectScript's toasts.
      showToast({ type: "success", title: `Deleted action "${script.name || "Unknown"}"` });
    } else {
      showToast({ type: "error", title: "Could not delete action", description: formError() ?? "An unexpected error occurred." });
    }
  }

  const scriptItems = () => (
    <>
      <Each of={props.scripts()} key={(script) => script.id}>
        {(script) => (
          <MenuItem accessibilityLabel={projectScriptMenuLabel(script())} disabled={!runnable()} class={itemClass} onSelect={() => props.onRun?.(script())}>
            <HIcon name={iconFor(script().icon)} size={16} />
            <Text class="min-w-0 flex-1 truncate text-sm text-popover-foreground">{projectScriptMenuLabel(script())}</Text>
            <View
              role="button"
              accessibilityLabel={`Edit ${script().name}`}
              onPress={() => openEdit(script())}
              class="size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
            >
              <HIcon name="settings" size={14} />
            </View>
          </MenuItem>
        )}
      </Each>
      {importable().length > 0 ? (
        <>
          {props.scripts().length > 0 ? <MenuSeparator class="my-1 h-px bg-border" /> : null}
          <Text class="px-2.5 py-1.5 text-xs font-medium text-muted-foreground">From t3.json</Text>
          <Each of={importable()} key={(file) => `${file.name} ${file.command}`}>
            {(file) => (
              <MenuItem accessibilityLabel={`Import ${file().name}`} class={itemClass} onSelect={() => void importFileScript(file())}>
                <HIcon name={iconFor(file().icon ?? "play")} size={16} />
                <Text class="min-w-0 flex-1 truncate text-sm text-popover-foreground">{file().name}</Text>
                <HIcon name="download" size={14} />
              </MenuItem>
            )}
          </Each>
        </>
      ) : null}
      <MenuItem accessibilityLabel="Add project script" class={itemClass} onSelect={openAdd}>
        <HIcon name="plus" size={16} />
        <Text class="text-sm text-popover-foreground">Add project script</Text>
      </MenuItem>
    </>
  );

  return (
    <>
      {primary() ? (
        <View role="group" accessibilityLabel="Project scripts" class="w-full flex-row items-center rounded-lg">
          <View
            role="button"
            accessibilityLabel={`Run ${primary()?.name}`}
            tooltip={<Tip text={runnable() ? `Run ${primary()?.name}` : "Pair this client again with permission to run terminal commands."} />}
            onPress={() => { const script = primary(); if (script) props.onRun?.(script); }}
            class={`${rowClass} flex-1 ${runnable() ? "" : "opacity-64"}`}
          >
            <HIcon name={iconFor(primary()?.icon ?? "play")} size={16} />
            <Text class={labelClass}>{primary()?.name ?? ""}</Text>
          </View>
          <Menu popupClass={menuClass} align="end" trigger={<View role="button" accessibilityLabel="Script actions" class="size-8 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"><HIcon name="chevron-down" size={16} /></View>}>
            {scriptItems()}
          </Menu>
        </View>
      ) : props.scripts().length > 0 || importable().length > 0 ? (
        <View role="group" accessibilityLabel="Project actions" class="w-full flex-row items-center rounded-lg">
          <View class={`${rowClass} flex-1`}>
            <HIcon name="wrench" size={16} />
            <Text class={labelClass}>Actions</Text>
          </View>
          <Menu popupClass={menuClass} align="end" trigger={<View role="button" accessibilityLabel="Choose project action" class="size-8 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"><HIcon name="chevron-down" size={16} /></View>}>
            {scriptItems()}
          </Menu>
        </View>
      ) : (
        <View role="button" accessibilityLabel="Add project script" tooltip={<Tip text="Add project script" />} onPress={openAdd} class={rowClass}>
          <HIcon name="plus" size={16} />
          <Text class={labelClass}>Add project script</Text>
        </View>
      )}
      {editor() !== null ? (
        <ScriptEditorDialog
          scriptId={editor()?.scriptId ?? null}
          initial={editor()?.initial ?? EMPTY_PROJECT_SCRIPT_INPUT}
          saving={saving}
          error={formError}
          onSubmit={(input) => { void submit(input); }}
          onDelete={() => { void confirmRemove(props.scripts().find((script) => script.id === editor()?.scriptId)); }}
          onClose={() => { if (!saving()) editor.set(null); }}
        />
      ) : null}
    </>
  );
}
