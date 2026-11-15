// The app's half of the terminal page's menus and links (ThreadTerminalDrawer.tsx: showTerminalContextMenu, showSelectionAction,
// handleLinkActivate, validateTerminalLink). A WebView draws above all app content, so the page cannot show a menu itself: it
// reports where the pointer was and what is selected, and the app opens its own menu at that point while the occlusion registry
// (rightPanel/nativeOcclusion.ts, through popupOverOverlay) hides the live page behind a still. The page keeps the terminal state
// (selection, scroll, paste encoding), so the actions that need it go back to the page as messages.
import { Clipboard, openUrl } from "nsh";
import { Menu } from "nsh/desktop";
import type { MenuItem } from "nsh/desktop";
import { requestBackend, settingValue } from "../../store";
import { popupOverOverlay } from "../files/filePopup";
import { canOperateEnvironment, OPEN_EDITOR_SCOPE_MESSAGE, preferredEditorAction } from "../files/fileActionsRuntime";
import { runLaunch } from "../files/fileActions";
import { canOpenLinksInApp, openUrlInPreviewTab } from "../browser/previewOpeners";
import { isTerminalUrl, resolvePathLinkTarget, terminalLinkTarget, validatePathLink } from "./terminalLinks";
import type { PageSelection } from "./terminalPageLogic";

export type TerminalMenuAction = "add-to-chat" | "copy" | "paste" | "select-all" | "scroll-to-bottom";
export interface TerminalMenuEntry { id: TerminalMenuAction; label: string; disabled?: boolean }

/** terminalSelectionMenuItems: the menu that follows a mouse selection. */
export function terminalSelectionMenuItems(options: { canAddToChat: boolean }): TerminalMenuEntry[] {
  return [...(options.canAddToChat ? [{ id: "add-to-chat" as const, label: "Add to chat" }] : []), { id: "copy", label: "Copy" }];
}

/** terminalContextMenuItems: the right-click menu (the selection's items are disabled without a selection). */
export function terminalContextMenuItems(options: { hasSelection: boolean; canAddToChat: boolean }): TerminalMenuEntry[] {
  return [
    ...terminalSelectionMenuItems({ canAddToChat: options.canAddToChat }).map((item) => ({ ...item, disabled: !options.hasSelection })),
    { id: "paste", label: "Paste" },
    { id: "select-all", label: "Select all" },
    { id: "scroll-to-bottom", label: "Jump to latest" },
  ];
}

type Rpc = (method: string, payload: unknown) => Promise<unknown>;
type SelectionReport = PageSelection & { clipboardText: string };

export interface TerminalPageBridgeDeps {
  terminalId: string;
  cwd: () => string;
  /** Sends a message to the page. */
  post: (message: Record<string, unknown>) => void;
  /** The WebView's own position in the window, in points. */
  origin: () => Promise<{ x: number; y: number } | null>;
  label: () => string;
  /** Puts a selection into the open thread's composer; absent where the terminal has no chat (the sign-in terminals). */
  addToChat?: (selection: { terminalId: string; terminalLabel: string; lineStart: number; lineEnd: number; text: string }) => boolean;
  focusPage: () => void;
  /** writeSystemMessage: a line `[terminal] text` in the terminal itself. */
  notice: (text: string) => void;
  /** False while the terminal is not on screen (another tab in front, the panel or drawer closed, another thread open): it opens no menu then. */
  onScreen?: () => boolean;
  rpc?: Rpc;
}

const record = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

function readSelection(value: unknown): SelectionReport | null {
  const item = record(value);
  if (!item || typeof item.text !== "string" || typeof item.clipboardText !== "string" || typeof item.lineStart !== "number" || typeof item.lineEnd !== "number") return null;
  return { text: item.text, clipboardText: item.clipboardText, lineStart: item.lineStart, lineEnd: item.lineEnd };
}

const messageOf = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

export function createTerminalPageBridge(deps: TerminalPageBridgeDeps) {
  const rpc = deps.rpc ?? requestBackend;
  const canAddToChat = () => deps.addToChat !== undefined;
  let menuOpen = false;
  // selectionActionRequestIdRef: a menu asked for before the terminal left the screen must not open after it.
  let menuRequest = 0;
  let pastedRequest = 0;

  async function copy(text: string) {
    try { await Clipboard.writeText(text); } catch (cause) { deps.notice(messageOf(cause, "Unable to copy terminal selection")); }
    deps.focusPage();
  }

  async function paste() {
    const request = ++pastedRequest;
    let text = "";
    try { text = await Clipboard.readText(); } catch (cause) { deps.notice(messageOf(cause, "Unable to read the clipboard")); return; }
    if (request !== pastedRequest) return;
    if (text.length > 0) deps.post({ type: "paste", text });
    deps.focusPage();
  }

  function run(action: TerminalMenuAction, selection: SelectionReport | null) {
    if (action === "add-to-chat") {
      // Output keeps moving the selected rows while a menu is open: the page re-reads the selection and answers only when the
      // same text is still selected, so the line numbers are those of now.
      if (selection && canAddToChat()) deps.post({ type: "add-to-chat-request", clipboardText: selection.clipboardText });
    } else if (action === "copy") {
      if (selection) void copy(selection.clipboardText);
    } else if (action === "paste") void paste();
    else { deps.post({ type: "menu-action", action }); deps.focusPage(); }
  }

  async function showMenu(entries: TerminalMenuEntry[], at: { x: number; y: number }, selection: SelectionReport | null) {
    if (menuOpen || deps.onScreen?.() === false) return;
    menuOpen = true;
    const request = ++menuRequest;
    const origin = (await deps.origin()) ?? { x: 0, y: 0 };
    if (request !== menuRequest) { menuOpen = false; return; }
    const items: MenuItem[] = entries.map((entry) => ({ label: entry.label, ...(entry.disabled ? { disabled: true } : {}), onSelect: () => run(entry.id, selection) }));
    try {
      await popupOverOverlay(items, { x: origin.x + at.x, y: origin.y + at.y }, "terminal menu");
    } catch (cause) {
      deps.notice(messageOf(cause, "Unable to open the terminal context menu"));
    } finally {
      menuOpen = false;
    }
    // A menu closed because its terminal left the screen (dismissMenu) does not pull the keyboard back to that terminal.
    if (request === menuRequest) deps.focusPage();
  }

  /**
   * clearSelectionAction (ThreadTerminalDrawer.tsx, `localApi.contextMenu.close()`): closes this terminal's open menu and drops
   * one still being asked for. The reference runs it when the terminal view goes away; here the view is kept mounted, so it
   * runs when the terminal leaves the screen (a tab switch, the panel or drawer closing, a thread switch) and on unmount.
   */
  function dismissMenu() {
    const wasOpen = menuOpen;
    menuRequest += 1;
    // The page's own pending gesture (a double click's wait) is not told: the menu it asks for later is refused while
    // the terminal is off screen (`onScreen`).
    // `Menu.popup` shows one menu at a time: an empty one closes the menu that is open and shows nothing.
    if (wasOpen) void Menu.popup([]).catch(() => {});
  }

  async function openPath(text: string) {
    try {
      const target = resolvePathLinkTarget(text, deps.cwd());
      // useOpenInPreferredEditor: refused without the operate scope.
      if (!(await canOperateEnvironment())) throw new Error(OPEN_EDITOR_SCOPE_MESSAGE);
      await runLaunch(await preferredEditorAction(rpc), target, rpc);
    } catch (cause) {
      deps.notice(messageOf(cause, "Unable to open path"));
    }
  }

  async function openLink(url: string, forceBrowser: boolean) {
    // The preview browser needs a thread's panel; the sign-in terminals have none and always use the system browser.
    const target = terminalLinkTarget(settingValue("browserLinkTarget"), forceBrowser, canOpenLinksInApp());
    if (target === "app") { openUrlInPreviewTab(url); return; }
    try { await openUrl(url); } catch (cause) { deps.notice(messageOf(cause, "Unable to open link")); }
  }

  return {
    dismissMenu,
    /** Handles the page's menu and link messages; false for any other message. */
    handle(message: Record<string, unknown>): boolean {
      const point = { x: typeof message.x === "number" ? message.x : 0, y: typeof message.y === "number" ? message.y : 0 };
      if (message.type === "contextmenu") {
        const selection = readSelection(message.selection);
        void showMenu(terminalContextMenuItems({ hasSelection: selection !== null, canAddToChat: canAddToChat() }), point, selection);
      } else if (message.type === "selection-action") {
        const selection = readSelection(message.selection);
        if (selection) void showMenu(terminalSelectionMenuItems({ canAddToChat: canAddToChat() }), point, selection);
      } else if (message.type === "add-to-chat-selection") {
        const selection = readSelection(message.selection);
        if (selection && deps.addToChat?.({ terminalId: deps.terminalId, terminalLabel: deps.label(), lineStart: selection.lineStart, lineEnd: selection.lineEnd, text: selection.text })) {
          deps.post({ type: "menu-action", action: "clear-selection" });
          deps.focusPage();
        }
      } else if (message.type === "link-check" && typeof message.id === "number" && typeof message.text === "string") {
        const id = message.id;
        void validatePathLink(message.text, deps.cwd(), rpc).then((valid) => deps.post({ type: "link-checked", id, valid }));
      } else if (message.type === "open-path" && typeof message.text === "string") void openPath(message.text);
      else if (message.type === "open-link" && typeof message.url === "string" && isTerminalUrl(message.url)) void openLink(message.url, message.forceBrowser === true);
      else return false;
      return true;
    },
  };
}
