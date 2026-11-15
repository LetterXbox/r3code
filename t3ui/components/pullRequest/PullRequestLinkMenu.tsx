// Wraps a pull request link so a right press offers Copy link and Open on the host (showPullRequestLinkContextMenu).
import { Clipboard, openUrl, signal, Text } from "nsh";
import { ContextMenu, MenuItem } from "nsh/base";
import { trackOpenChange, useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { openOnHostLabel, pullRequestLinkContextMenuItems, type PullRequestLinkContextMenuAction } from "./pullRequestLinkContextMenu";
import { MENU_ITEM_ROW_CLASS, MENU_POPUP_CLASS } from "../menuStyles";

export function PullRequestLinkMenu(props: { url: string; provider: string; onFailed?: (message: string) => void; children: unknown }) {
  const open = signal(false);
  useOverlayOpen(open, "pull request link menu");
  function run(action: PullRequestLinkContextMenuAction) {
    if (action === "copy-link") Clipboard.writeText(props.url).catch(() => props.onFailed?.("Could not copy the link"));
    else void openUrl(props.url).catch(() => props.onFailed?.("Could not open the link"));
  }
  return (
    <ContextMenu popupClass={MENU_POPUP_CLASS} onOpenChange={trackOpenChange(open)} trigger={props.children as never}>
      <>
        {pullRequestLinkContextMenuItems(openOnHostLabel(props.provider)).map((item) => (
          <MenuItem accessibilityLabel={item.label} class={MENU_ITEM_ROW_CLASS} onSelect={() => run(item.id)}>
            <Text class="text-sm text-popover-foreground">{item.label}</Text>
          </MenuItem>
        ))}
      </>
    </ContextMenu>
  );
}

