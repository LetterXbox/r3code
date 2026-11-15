// The panel shortcuts from DEFAULT_KEYBINDINGS (packages/shared/src/keybindings.ts):
// rightPanel.toggle, threadPanel.toggle, diff.toggle, rightPanel.close (mod+w) and rightPanel.new (mod+t). terminal.toggle (mod+j)
// is bound by the thread view, which also hides the terminal under overlays.
import { registerCommands } from "../../commands/registry";
import { closeActiveSurfaceAction, toggleDetailsAction, toggleDiffAction, toggleMaximizedAction, toggleRightPanelAction } from "./panelState";
import { addSurfaceMenuOpen } from "./RightPanel";
import { currentWorkspaceFocusArea, requestWorkspaceFocus } from "../../commands/workspaceFocus";
import { detailsPanelKey, panelStateFor, currentPanelKey } from "./panelState";

/** useRightPanelActions toggleThreadPanel: opening the details card moves the keyboard into it; closing it from inside hands it back to the chat. */
export function toggleDetailsWithFocus() {
  const wasOpen = panelStateFor(detailsPanelKey()).detailsOpen;
  toggleDetailsAction();
  if (!wasOpen) setTimeout(() => requestWorkspaceFocus("details"), 0);
  else if (currentWorkspaceFocusArea() === "details") requestWorkspaceFocus("thread");
}

/** useRightPanelActions toggleRightPanelMaximized: maximizing moves the keyboard to the panel. */
export function toggleMaximizedWithFocus() {
  const wasMaximized = panelStateFor(currentPanelKey()).maximized;
  toggleMaximizedAction();
  if (!wasMaximized) setTimeout(() => requestWorkspaceFocus("rightPanel"), 0);
}

/** Registers the commands for as long as the calling component is mounted. */
export function bindPanelKeys(overlayOpen: () => boolean = () => false) {
  const guard = (action: () => void) => () => { if (!overlayOpen()) action(); };
  return registerCommands({
    "rightPanel.toggle": guard(toggleRightPanelAction),
    "threadPanel.toggle": guard(toggleDetailsWithFocus),
    // useRightPanelActions: rightPanel.toggleMaximized (a user-bound shortcut; no default key in DEFAULT_KEYBINDINGS).
    "rightPanel.toggleMaximized": guard(toggleMaximizedWithFocus),
    "diff.toggle": guard(toggleDiffAction),
    "rightPanel.close": () => { if (overlayOpen()) return false; closeActiveSurfaceAction(); },
    "rightPanel.new": () => { if (overlayOpen()) return false; addSurfaceMenuOpen.set(true); },
  });
}
