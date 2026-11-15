// Keybindings, ported from KeybindingsSettings.tsx: a search field over the
// web's grouped command list. Each row shows its label, `When` clause and a
// key pill; pressing the pill records a new chord, Save sends it to the
// server (`server.upsertKeybinding`, replacing the old chord), and a custom
// row can be reset to its default or removed (`server.removeKeybinding`).
//
// The list is the web's default catalog (generated) with the connected
// server's resolved bindings laid over it. Disconnected, it is read-only and
// says so.
import { keymap, signal, Text, token, View } from "nsh";
import { Input, Menu, MenuItem } from "nsh/base";
import { SettingsRow, SettingsSection, SettingsSelect } from "../../components/SettingsLayout";
import { useOverlayOpen } from "../../components/rightPanel/nativeOcclusion";
import { MENU_ITEM_ROW_CLASS } from "../../components/menuStyles";
import { openKeybindingsFile } from "../../shell/keybindingsToast";
import { codeTextStyle } from "../../typography";
import { SettingsIcon } from "./SettingsIcon";
import { WarningMark, WhenClauseControl } from "./WhenBuilder";
import { DEFAULT_KEYBINDING_RULES } from "../../commands/defaultKeybindings";
import { parseWhen } from "../../commands/whenClause";
import {
  WHEN_PARSE_MESSAGE, buildRows, commandLabel, commandOptions, conflictLabels, contractKeyFromNsh, filterRows, formatKey, groupRows, keycaps, knownWhenVariables,
  newBindingPayload, recordableKeystrokes, resetPayload, rowTarget, rulesFromResolved, unknownWhenIdentifiers, upsertPayload, whenToExpression, type KeybindingRow,
} from "./keybindingsLogic";
import { isServerConnected, requestServer } from "./settingsSync";
import { replaceServerKeybindings, serverKeybindings } from "./settingsState";
import { settingsWriteDenied } from "./settingsWriteAccess";
import { errorToast } from "../../components/toast";

const DEFAULTS = DEFAULT_KEYBINDING_RULES;

const query = signal("");
const recordingId = signal<string | null>(null);
const drafts = signal<Record<string, string>>({});
const savingId = signal<string | null>(null);
const failure = signal("");
let stopRecording: (() => void) | null = null;

function endRecording() {
  stopRecording?.();
  stopRecording = null;
  recordingId.set(null);
}

/** Captures one chord for `id` and hands its keybindings.json spelling to `onKey`; Escape cancels. */
function startCapture(id: string, onKey: (key: string) => void) {
  endRecording();
  recordingId.set(id);
  const removers: (() => void)[] = [];
  const bind = (keystroke: string, handler: () => void) => {
    // Some chords belong to the platform (Command+Q) and cannot be bound.
    try { removers.push(keymap.bind(keystroke, handler, { when: "always" })); } catch { /* reserved */ }
  };
  for (const chord of recordableKeystrokes()) {
    bind(chord, () => {
      onKey(contractKeyFromNsh(chord));
      endRecording();
    });
  }
  bind("escape", endRecording);
  stopRecording = () => removers.forEach((remove) => remove());
}

/** Starts capturing one chord for a row; Escape cancels. */
export function startRecording(row: KeybindingRow) {
  startCapture(row.id, (key) => drafts.update((all) => ({ ...all, [row.id]: key })));
}

const whenDrafts = signal<Record<string, string>>({});
const whenEditing = signal<string | null>(null);
const adding = signal(false);
const newCommand = signal("");
const newKey = signal("");
const newWhen = signal("");
const NEW_ID = "new-keybinding";

function openAdd() {
  failure.set("");
  // The web starts with no command chosen (a "Command" placeholder).
  newCommand.set("");
  newKey.set("");
  newWhen.set("");
  adding.set(true);
}

function closeAdd() {
  if (recordingId() === NEW_ID) endRecording();
  adding.set(false);
}

function currentRows(): KeybindingRow[] {
  return buildRows(DEFAULTS, rulesFromResolved(isServerConnected() ? serverKeybindings() : []).filter((rule) => !DEFAULTS.some((d) => d.command === rule.command && d.key === rule.key && d.when === rule.when)));
}

async function run(id: string, method: string, payload: unknown) {
  savingId.set(id);
  failure.set("");
  try {
    const result = (await requestServer(method, payload)) as { keybindings?: unknown } | null;
    replaceServerKeybindings(result?.keybindings);
    drafts.update(({ [id]: _gone, ...rest }) => rest);
    whenDrafts.update(({ [id]: _gone, ...rest }) => rest);
    if (whenEditing() === id) whenEditing.set(null);
  } catch (cause) {
    failure.set(cause instanceof Error ? cause.message : String(cause));
    // KeybindingsSettings.tsx:1405-1409 / 1436-1440: a failed save or removal raises an error toast.
    const removing = method === "server.removeKeybinding";
    errorToast(
      removing ? "Unable to remove keybinding" : "Unable to save keybinding",
      cause instanceof Error && cause.message ? cause.message : removing ? "The keybinding was not removed." : "The keybinding was not saved.",
    );
  } finally {
    savingId.set(null);
  }
}

/** The when-clause editor: an expression field with the web's parse and unknown-condition messages. */
function WhenEditor(props: { value: () => string; label: string; onChange: (next: string) => void }) {
  const known = knownWhenVariables(DEFAULTS);
  const error = () => (props.value().trim().length > 0 && parseWhen(props.value()) === null ? WHEN_PARSE_MESSAGE : "");
  const unknown = () => (error() ? [] : unknownWhenIdentifiers(props.value(), known));
  return (
    <View class="w-[34rem] max-w-full gap-1.5" role="group" accessibilityLabel={`When clause editor for ${props.label}`}>
      <Text class="text-sm font-medium text-foreground">When</Text>
      <Input
        value={props.value()}
        placeholder="Always"
        accessibilityLabel="When expression"
        autoCapitalize="none"
        autoCorrect={false}
        onChange={(event) => props.onChange(event.value)}
        class="h-7 w-full rounded-lg border border-input bg-background px-3 font-mono text-xs text-foreground"
      />
      {error() ? <Text class="text-2xs text-destructive-foreground">{error()}</Text> : null}
      {unknown().length > 0 ? (
        <Text class="text-2xs text-warning-foreground">
          {`${unknown().length === 1 ? `Unknown condition: ${unknown()[0]}` : `Unknown conditions: ${unknown().join(", ")}`}. R3 Code does not recognize this condition yet. It can still be saved, but it may not match unless the runtime provides it.`}
        </Text>
      ) : null}
    </View>
  );
}

const invalidWhen = signal<string[]>([]);

function setWhenValid(id: string, valid: boolean) {
  invalidWhen.update((all) => (valid ? all.filter((entry) => entry !== id) : all.includes(id) ? all : [...all, id]));
}

/** The AST of a stored when expression, undefined for "Always" or a clause that does not parse. */
function whenAst(expression: string) {
  return expression.trim().length > 0 ? parseWhen(expression) ?? undefined : undefined;
}

const CONFLICT_HINT = "The most recent matching binding wins when both conditions can apply.";

/** KeybindingConflictWarning: a warning mark that names what the key also does. */
function ConflictWarning(props: { labels: () => string[] }) {
  const description = () => {
    const labels = props.labels();
    return labels.length === 1 ? `Conflicts with ${labels[0]}.` : `Conflicts with ${labels.slice(0, 3).join(", ")}${labels.length > 3 ? ", and more" : ""}.`;
  };
  return props.labels().length > 0 ? <WarningMark label={description()} hint={CONFLICT_HINT} /> : null;
}

/** KeybindingPill: one rounded keycap per part of the shortcut (`Kbd`: `h-5 min-w-5 rounded bg-foreground/[0.07] px-1 text-xs`). */
function Keycaps(props: { value: string }) {
  return (
    <View class="flex-row items-center gap-1">
      {keycaps(props.value).map((label) => (
        <View class="h-5 min-w-5 items-center justify-center rounded bg-kbd-key px-1">
          <Text class="text-xs font-medium text-muted-foreground">{label}</Text>
        </View>
      ))}
    </View>
  );
}

const MENU_CLASS = "min-w-36 rounded-lg border border-border bg-popover-84 p-1 shadow-lg";
const MENU_ITEM_CLASS = MENU_ITEM_ROW_CLASS;

/** KeybindingRowMenu: the ellipsis menu of a changed row (Reset to default, Remove). Shown while the row is hovered or the menu is open. */
function RowActionsMenu(props: { row: KeybindingRow; busy: () => boolean; visible: () => boolean; onOpen: (open: boolean) => void }) {
  const row = props.row;
  const canReset = row.source === "Custom" && row.defaultKey !== null;
  const canRemove = row.source !== "Default";
  const open = signal(false);
  useOverlayOpen(() => open(), "keybinding row menu");
  if (!canReset && !canRemove) return null;
  return (
    <View class={props.visible() || open() ? "transition-opacity duration-150 ease-in-out" : "opacity-0 transition-opacity duration-150 ease-in-out"}>
      <Menu
        popupClass={MENU_CLASS}
        align="end"
        onOpenChange={(event: { open: boolean }) => { open.set(event.open); props.onOpen(event.open); }}
        trigger={
          <View role="button" accessibilityLabel={`Actions for ${commandLabel(row.command)}`} disabled={props.busy()} class="size-7 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out">
            <SettingsIcon name="ellipsis" size={14} tint={token("muted-foreground")} />
          </View>
        }
      >
        {canReset ? (
          <MenuItem accessibilityLabel="Reset to default" class={MENU_ITEM_CLASS} disabled={props.busy()} onSelect={() => void run(row.id, "server.upsertKeybinding", resetPayload(row))}>
            <Text class="min-w-0 flex-1 text-sm text-popover-foreground">Reset to default</Text>
          </MenuItem>
        ) : null}
        {canRemove ? (
          <MenuItem accessibilityLabel="Remove" class={MENU_ITEM_CLASS} disabled={props.busy()} onSelect={() => void run(row.id, "server.removeKeybinding", rowTarget(row))}>
            <Text class="min-w-0 flex-1 text-sm text-destructive-foreground">Remove</Text>
          </MenuItem>
        ) : null}
      </Menu>
    </View>
  );
}

/** The `Badge variant="outline" size="sm"` beside a changed row's title. */
function SourceBadge(props: { source: string }) {
  return (
    <View class="h-4 min-w-4 items-center justify-center rounded border border-input px-[3px]">
      <Text class="text-[10px] font-medium leading-none text-foreground">{props.source}</Text>
    </View>
  );
}

/** The recorder field (`Input size="sm" font="mono" className="w-44"`): "Press shortcut" while recording, the chord typed so far otherwise. */
function KeyField(props: { label: string; testID: string; recording: () => boolean; value: () => string; onPress: () => void }) {
  return (
    <View
      role="button"
      class="h-7 w-44 justify-center rounded-lg border border-input bg-background px-[9px] dark:bg-input-32"
      accessibilityLabel={props.label}
      testID={props.testID}
      onPress={props.onPress}
    >
      <Text class={props.recording() || props.value() === "" ? "text-sm text-placeholder" : "text-sm text-foreground"} style={{ fontFamily: codeTextStyle().fontFamily }}>
        {props.recording() ? "Press shortcut" : props.value() !== "" ? formatKey(props.value()) : "Unassigned"}
      </Text>
    </View>
  );
}

const SAVE_CLASS = "h-7 items-center justify-center rounded-lg border border-primary bg-primary px-[9px] active:scale-[0.97] transition-transform duration-150 ease-in-out";

function NewKeybinding() {
  const defaults = DEFAULTS;
  const canSave = () => newCommand() !== "" && newKey().trim().length > 0 && !invalidWhen().includes(NEW_ID) && savingId() !== NEW_ID;
  const conflicts = () => conflictLabels(currentRows(), NEW_ID, newKey().trim(), newWhen().trim());
  const options = () => commandOptions(DEFAULTS, rulesFromResolved(isServerConnected() ? serverKeybindings() : [])).map((command) => ({ value: command, label: commandLabel(command) }));
  const commandText = () => (newCommand() ? commandLabel(newCommand()) : "new keybinding");
  return (
    <SettingsSection title="New keybinding" hideTitle>
      <View class="rounded-xl bg-muted-10">
        <SettingsRow
          title="New keybinding"
          status={
            <View class="-mt-0.5 h-6 flex-row items-center gap-1.5">
              <Text class="text-xs leading-none text-muted-foreground-70">When</Text>
              <WhenClauseControl
                label={commandText()}
                expression={() => newWhen().trim()}
                value={() => whenAst(newWhen())}
                defaults={defaults}
                onChange={(node) => newWhen.set(whenToExpression(node))}
                onValidityChange={(valid) => setWhenValid(NEW_ID, valid)}
              />
            </View>
          }
          control={
            <View class="flex-row flex-wrap items-center gap-2">
              <SettingsSelect label="New keybinding command" value={newCommand()} options={options()} compactWidth={224} triggerLabel={newCommand() === "" ? "Command" : commandLabel(newCommand())} onChange={(next: string) => newCommand.set(next)} />
              <ConflictWarning labels={conflicts} />
              <KeyField
                label={`Keybinding for ${commandText()}`}
                testID={`New keybinding = ${newKey()}`}
                recording={() => recordingId() === NEW_ID}
                value={newKey}
                onPress={() => startCapture(NEW_ID, (key) => newKey.set(key))}
              />
              <View
                role="button"
                accessibilityLabel="Save new keybinding"
                disabled={!canSave()}
                class={`${SAVE_CLASS} ${canSave() ? "" : "opacity-64"}`}
                onPress={() => void run(NEW_ID, "server.upsertKeybinding", newBindingPayload(newCommand(), newKey(), newWhen())).then(() => { if (!failure()) closeAdd(); })}
              >
                <Text class="text-sm font-medium text-primary-foreground">{savingId() === NEW_ID ? "Saving" : "Save"}</Text>
              </View>
              <View role="button" class="size-7 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out" accessibilityLabel="Cancel new keybinding" tooltip="Cancel" disabled={savingId() === NEW_ID} onPress={closeAdd}>
                <SettingsIcon name="x" size={14} tint={token("muted-foreground")} />
              </View>
            </View>
          }
        />
      </View>
    </SettingsSection>
  );
}

function KeybindingRowView(props: { row: KeybindingRow }) {
  const row = props.row;
  const label = commandLabel(row.command);
  const draft = () => drafts()[row.id];
  const whenDraft = () => whenDrafts()[row.id];
  const keyValue = () => draft() ?? row.key;
  const whenExpression = () => (whenDraft() ?? row.when).trim();
  const dirty = () => (draft() !== undefined && draft() !== row.key) || (whenDraft() !== undefined && whenDraft()!.trim() !== row.when);
  const busy = () => savingId() === row.id;
  const recording = () => recordingId() === row.id;
  const showPill = () => !recording() && keyValue() === row.key && row.key.length > 0 && !dirty();
  const conflicts = () => conflictLabels(currentRows(), row.id, keyValue(), whenExpression());
  const hovered = signal(false);
  const menuOpen = signal(false);
  const testID = () => `Keybinding ${row.command} = ${keyValue()}`;
  return (
    <View onMouseEnter={() => hovered.set(true)} onMouseLeave={() => hovered.set(false)}>
      <SettingsRow
        title={label}
        titleNode={
          <View class="flex-row items-center gap-2" tooltip={row.command}>
            <Text class="text-sm font-medium text-foreground">{label}</Text>
            {row.source !== "Default" ? <SourceBadge source={row.source} /> : null}
          </View>
        }
        status={
          <View class="-mt-0.5 h-6 flex-row items-center gap-1.5">
            <Text class="text-xs leading-none text-muted-foreground-70">When</Text>
            <WhenClauseControl
              label={label}
              expression={whenExpression}
              value={() => whenAst(whenExpression())}
              defaults={DEFAULTS}
              onChange={(node) => whenDrafts.update((all) => ({ ...all, [row.id]: whenToExpression(node) }))}
              onValidityChange={(valid) => setWhenValid(row.id, valid)}
            />
          </View>
        }
        control={
          <View class="flex-row flex-wrap items-center justify-end gap-1.5">
            <ConflictWarning labels={conflicts} />
            <RowActionsMenu row={row} busy={busy} visible={() => hovered() || menuOpen()} onOpen={(open) => menuOpen.set(open)} />
            {dirty() ? (
              <View
                role="button"
                accessibilityLabel={`Save shortcut for ${label}`}
                disabled={busy() || keyValue().trim().length === 0 || invalidWhen().includes(row.id)}
                class={`${SAVE_CLASS} ${busy() || keyValue().trim().length === 0 || invalidWhen().includes(row.id) ? "opacity-64" : ""}`}
                onPress={() => void run(row.id, "server.upsertKeybinding", upsertPayload(row, keyValue(), whenDraft() ?? row.when))}
              >
                <Text class="text-sm font-medium text-primary-foreground">{busy() ? "Saving" : "Save"}</Text>
              </View>
            ) : null}
            {showPill() ? (
              <View
                role="button"
                class="-mr-1.5 h-7 flex-row items-center rounded-md border border-transparent px-1.5 hover:border-border-70 hover:bg-accent transition-colors duration-150 ease-in-out"
                accessibilityLabel={`Edit shortcut for ${label}: ${formatKey(row.key)}`}
                testID={testID()}
                onPress={() => startRecording(row)}
              >
                <Keycaps value={row.key} />
              </View>
            ) : (
              <KeyField label={`Keybinding for ${label}`} testID={testID()} recording={recording} value={keyValue} onPress={() => startRecording(row)} />
            )}
          </View>
        }
      />
    </View>
  );
}

export function KeybindingsSettings() {
  const writable = () => isServerConnected() && !settingsWriteDenied();
  return (
    <>
      <SettingsSection title="Keybindings">
        <View class="flex-row flex-wrap items-center gap-2 px-4 py-3">
          <View class="h-8 min-w-0 flex-1 flex-row items-center gap-2 rounded-lg border border-input bg-background px-[11px] dark:bg-input-32">
            <View class="size-3.5 items-center justify-center opacity-80"><SettingsIcon name="search" size={14} tint={token("foreground")} /></View>
            <Input
              value={query()}
              placeholder="Search keybindings"
              accessibilityLabel="Search keybindings"
              onChange={(event) => query.set(event.value)}
              class="h-8 min-w-0 flex-1 text-sm text-foreground"
            />
          </View>
          <View
            role="button"
            accessibilityLabel="Add keybinding"
            disabled={!writable() || adding()}
            onPress={openAdd}
            class={`h-8 flex-row items-center justify-center gap-2 rounded-lg border border-input bg-background px-[11px] hover:bg-accent dark:bg-input-32 ${!writable() || adding() ? "opacity-64" : ""}`}
          >
            <SettingsIcon name="plus" size={16} tint={token("muted-foreground")} />
            <Text class="text-sm font-medium text-foreground">Add keybinding</Text>
          </View>
          <View
            role="button"
            accessibilityLabel="Open keybindings.json"
            tooltip="Open keybindings.json"
            disabled={!writable()}
            onPress={() => void openKeybindingsFile(undefined, "The keybindings file was not opened.")}
            class={`size-8 items-center justify-center rounded-lg border border-input bg-background hover:bg-accent dark:bg-input-32 ${!writable() ? "opacity-64" : ""}`}
          >
            <SettingsIcon name="file-json" size={16} tint={token("muted-foreground")} />
          </View>
        </View>
      </SettingsSection>
      {!writable() ? <Text class="text-xs text-muted-foreground">{isServerConnected() ? "This connection can view keybindings but cannot change them." : "Connect an environment to change keybindings."}</Text> : null}
      <View class="gap-8" style={writable() ? undefined : { pointerEvents: "none" }}>
        {adding() ? <NewKeybinding /> : null}
        {filterRows(currentRows(), query()).length === 0 ? (
          <SettingsSection title="Results" hideTitle>
            <View class="px-4 py-12 items-center"><Text class="text-sm text-muted-foreground">No keybindings match your search.</Text></View>
          </SettingsSection>
        ) : null}
        <Each of={groupRows(filterRows(currentRows(), query()))} key={(group) => group.id}>
          {(group) => (
            <SettingsSection title={group().title}>
              <Each of={group().rows} key={(row) => row.id}>
                {(row, i) => (
                  <View>
                    {i() > 0 ? <View class="h-px bg-border-50" /> : null}
                    <KeybindingRowView row={row()} />
                  </View>
                )}
              </Each>
            </SettingsSection>
          )}
        </Each>
      </View>
    </>
  );
}
