// Terminal drawer commands from DEFAULT_KEYBINDINGS (packages/shared/src/keybindings.ts),
// all `when: "terminalFocus"`: terminal.split, terminal.splitVertical, terminal.new and
// terminal.close. The command dispatcher registers these handlers; they act on the open
// thread's drawer and do nothing while it is closed.
import { signal } from "nsh";
import { confirm, confirmDialogAvailable } from "../toast/confirmDialog";
import { registerCommands, defineContext, dispatchKeystroke } from "../../commands/registry";
import { nshKeystroke } from "../../commands/keystroke";
import { requestBackend } from "../../store";
import {
  closePanelTerminalAction, currentPanelKey, currentWorkspace, openTerminalSurfaceAction, panelStateFor, splitPanelTerminalAction,
} from "../rightPanel/panelState";
import { drawerStateFor, suppressDrawerTerminal, updateDrawer } from "./drawerState";
import { canLaunchTerminal, drawerAllocation } from "./terminalAllocation";
import { closeTerminal, hasReachedSplitLimit, newTerminal, splitTerminal, terminalLabel } from "./terminalLogic";
import { drawerTypingWanted } from "./terminalTyping";

export const TERMINAL_SHORTCUTS = {
  "terminal.split": "mod+d",
  "terminal.splitVertical": "mod+shift+d",
  "terminal.new": "mod+n",
  "terminal.close": "mod+w",
} as const;

export type TerminalCommand = keyof typeof TERMINAL_SHORTCUTS;

type Rpc = (method: string, payload: unknown) => Promise<unknown>;

/** Which terminal holds the keyboard: one of the drawer, or one of a panel tab. */
export type TerminalFocusTarget = { kind: "drawer" } | { kind: "panel"; surfaceId: string; terminalId: string };

const focusTarget = signal<TerminalFocusTarget | null>(null);

/** The `terminalFocus` context: true while a terminal's page reports that its input has the focus. */
// Also while the drawer is where typing is meant to go but its web view cannot be given the keyboard (terminalTyping.ts).
export const terminalFocused = () => focusTarget() !== null || drawerTypingWanted();
export const terminalFocusTarget = () => focusTarget();

/** The terminal page said its input gained (`focused`) or lost the focus. A blur only counts for the terminal that owned the focus. */
export function reportTerminalFocus(target: TerminalFocusTarget, focused: boolean) {
  const current = focusTarget();
  if (focused) { if (!sameTarget(current, target)) focusTarget.set(target); return; }
  if (current && current.kind === target.kind && (current.kind === "drawer" || (target.kind === "panel" && current.surfaceId === target.surfaceId && current.terminalId === target.terminalId))) focusTarget.set(null);
}
export const setTerminalFocus = (focused: boolean) => {
  if (!focused) { if (focusTarget() !== null) focusTarget.set(null); return; }
  if (!sameTarget(focusTarget(), { kind: "drawer" })) focusTarget.set({ kind: "drawer" });
};

// Repeated focus reports for the same terminal must not notify: every focus-state message would otherwise re-run
// everything that reads the focus context.
function sameTarget(a: TerminalFocusTarget | null, b: TerminalFocusTarget): boolean {
  if (!a || a.kind !== b.kind) return false;
  return a.kind === "drawer" || (b.kind === "panel" && a.surfaceId === b.surfaceId && a.terminalId === b.terminalId);
}

/** `previewFocus`: a preview browser tab was pressed and nothing else has taken the keyboard since. */
export const previewFocused = signal(false);

/**
 * A chord the terminal page forwarded ("mod+d"): run it as if it had been pressed in the window.
 * The page only forwards chords while its input has the focus, so terminalFocus holds for it.
 */
export function runTerminalChord(chord: string, target: TerminalFocusTarget): boolean {
  if (!terminalFocused()) focusTarget.set(target);
  const keystroke = nshKeystroke(chord);
  return keystroke === null ? false : dispatchKeystroke(keystroke);
}

function openDrawerKey(): string | null {
  const key = currentPanelKey();
  return key && panelStateFor(key).terminalOpen ? key : null;
}

/** The web's confirmTerminalClose: one destructive confirmation naming the terminals; true when no dialog host exists. */
export async function confirmTerminalClose(labels: readonly [string, ...string[]]): Promise<boolean> {
  if (!confirmDialogAvailable()) return true;
  return confirm(
    labels.length === 1
      ? [`Close terminal "${labels[0]}"?`, "This stops the running process and clears its history."].join("\n")
      : [`Close ${labels.length} terminals?`, `This stops their running processes and clears their histories: ${labels.map((label) => `"${label}"`).join(", ")}.`].join("\n"),
    { variant: "destructive" },
  );
}

/** Closes one terminal: the drawer forgets it at once and the server is told. Resolves with an error message, or null. */
export async function closeTerminalSession(stateKey: string, threadId: string, terminalId: string, rpc: Rpc = requestBackend): Promise<string | null> {
  // The web asks first (lib/terminalCloseConfirm.ts): closing stops the process and clears its history.
  if (!(await confirmTerminalClose([terminalLabel(terminalId)]))) return null;
  updateDrawer(stateKey, (current) => closeTerminal(current, terminalId));
  suppressDrawerTerminal(stateKey, terminalId);
  try {
    // closeTerminalSession of useThreadTerminalActions.ts: a close deletes the session's history too.
    await rpc("terminal.close", { threadId, terminalId, deleteHistory: true });
  } catch {
    // A failed close shows nothing there: it types `exit` into the session instead (best effort).
    await rpc("terminal.write", { threadId, terminalId, data: "exit\n" }).catch(() => {});
  }
  return null;
}

/**
 * A session that ended by itself (the user typed `exit`, the process died): the web closes its terminal without asking
 * (ThreadTerminalDrawer.handleSessionExited). The drawer forgets it and the server drops its history; a failed close falls back to
 * typing `exit`, as the web does.
 */
export async function closeEndedTerminal(stateKey: string, threadId: string, terminalId: string, rpc: Rpc = requestBackend): Promise<void> {
  updateDrawer(stateKey, (current) => closeTerminal(current, terminalId));
  suppressDrawerTerminal(stateKey, terminalId);
  try {
    await rpc("terminal.close", { threadId, terminalId, deleteHistory: true });
  } catch {
    await rpc("terminal.write", { threadId, terminalId, data: "exit\n" }).catch(() => {});
  }
}

/** closeEndedTerminal for a terminal of a right-panel tab. */
export async function closeEndedPanelTerminal(threadId: string, terminalId: string, rpc: Rpc = requestBackend): Promise<void> {
  closePanelTerminalAction(terminalId);
  try {
    await rpc("terminal.close", { threadId, terminalId, deleteHistory: true });
  } catch {
    await rpc("terminal.write", { threadId, terminalId, data: "exit\n" }).catch(() => {});
  }
}

function focusedPanelTerminal() {
  const target = focusTarget();
  return target && target.kind === "panel" ? target : null;
}

function splitFocused(direction: "horizontal" | "vertical") {
  const panel = focusedPanelTerminal();
  if (panel) { splitPanelTerminalAction(panel.surfaceId, direction); return; }
  const key = openDrawerKey();
  if (key && canLaunchTerminal() && !hasReachedSplitLimit(drawerStateFor(key))) updateDrawer(key, (current) => splitTerminal(current, direction, drawerAllocation(key)));
}

export function terminalSplitAction() { splitFocused("horizontal"); }
export function terminalSplitVerticalAction() { splitFocused("vertical"); }

/** terminal.new: a terminal in the drawer, or another tab of the panel when a panel terminal has the focus. */
export function terminalNewAction() {
  if (focusedPanelTerminal()) { openTerminalSurfaceAction(); return; }
  const key = openDrawerKey();
  if (key && canLaunchTerminal()) updateDrawer(key, (current) => newTerminal(current, drawerAllocation(key)));
}

export function terminalCloseAction(rpc?: Rpc) {
  const panel = focusedPanelTerminal();
  const space = currentWorkspace();
  if (panel && space) {
    closePanelTerminalAction(panel.terminalId);
    focusTarget.set(null);
    const send = rpc ?? requestBackend;
    void send("terminal.close", { threadId: space.threadId, terminalId: panel.terminalId, deleteHistory: true })
      .catch(() => send("terminal.write", { threadId: space.threadId, terminalId: panel.terminalId, data: "exit\n" }).catch(() => {}));
    return;
  }
  const key = openDrawerKey();
  const id = key ? drawerStateFor(key).activeTerminalId : null;
  if (key && space && id) void closeTerminalSession(key, space.threadId, id, rpc);
}

/**
 * Registers the terminal commands and the `terminalFocus` / `previewFocus` contexts for as long as the
 * calling component is mounted. terminal.toggle (mod+j) is bound by the thread view, which also
 * hides the terminal under overlays.
 */
export function bindTerminalKeys() {
  defineContext("terminalFocus", terminalFocused);
  defineContext("previewFocus", () => previewFocused());
  return registerCommands({
    "terminal.split": () => { if (!terminalFocused()) return false; terminalSplitAction(); },
    "terminal.splitVertical": () => { if (!terminalFocused()) return false; terminalSplitVerticalAction(); },
    "terminal.new": () => { if (!terminalFocused()) return false; terminalNewAction(); },
    "terminal.close": () => { if (!terminalFocused()) return false; terminalCloseAction(); },
  });
}
