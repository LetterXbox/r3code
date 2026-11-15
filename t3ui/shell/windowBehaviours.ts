// What routes/__root.tsx, routes/_chat.tsx and AppSidebarLayout.tsx do for the whole window, beyond the pages themselves.
import { effect, keymap } from "nsh";
import { closeUtility, paletteOpen, settingsOpen, usageOpen, utilityPage } from "../store";
import { confirmDialogOpen } from "../components/toast/confirmDialog";
import { clearThreadSelection, hasThreadSelection } from "../components/sidebar/threadSelection";

/**
 * registerPullRequestsEscapeCommand: Escape leaves the pull requests page when nothing else claimed it, so it is the first
 * binding the page makes and every dialog, menu and the palette over it binds later and takes the key first.
 */
export function installPullRequestsEscape() {
  effect(() => {
    if (utilityPage() !== "pull-requests" || settingsOpen() || usageOpen() || paletteOpen() || confirmDialogOpen()) return;
    return keymap.bind({ escape: closeUtility });
  });
}

/**
 * chatRouteCommands `onKeyDown`: Escape clears the thread multi-selection when there is one. Like the pull requests Escape it binds only while
 * it applies, after the page's own bindings, and every dialog, menu and the palette over the page binds later and takes the key first.
 */
export function installThreadSelectionEscape() {
  effect(() => {
    if (!hasThreadSelection() || settingsOpen() || usageOpen() || paletteOpen() || confirmDialogOpen()) return;
    return keymap.bind({ escape: clearThreadSelection });
  });
}
