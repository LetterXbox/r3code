// The tab context menu's items (RightPanelTabs.tsx handleTabContextMenu) and the path "Copy path" puts on the clipboard.
// Pure, so the menu's content is tested although `Menu.popup` itself is native.
import type { Surface } from "./panelLogic";
import { resolvePathLinkTarget } from "../terminal/terminalLinks";

export type TabMenuAction = "rename" | "copy-path" | "toggle-mute" | "close" | "close-others" | "close-to-right" | "close-all";

export interface TabMenuItem { id: TabMenuAction; label: string; disabled?: boolean }

export interface TabMenuContext {
  /** How many tabs the panel has, and where this one sits among them. */
  count: number;
  index: number;
  /** The browser tab's mute control: absent for a tab that is not a browser; `ready` once its page is up (tabMuteMenuItem). */
  mute?: { ready: boolean; muted: boolean };
}

/** Rename (device tabs), Copy path (file tabs), Mute or Unmute tab (browser tabs), then the four Close items. */
export function tabMenuItems(surface: Pick<Surface, "kind">, context: TabMenuContext): TabMenuItem[] {
  const items: TabMenuItem[] = [];
  if (surface.kind === "device") items.push({ id: "rename", label: "Rename" });
  if (surface.kind === "file") items.push({ id: "copy-path", label: "Copy path" });
  if (surface.kind === "preview" && context.mute) items.push({ id: "toggle-mute", label: context.mute.muted ? "Unmute tab" : "Mute tab", disabled: !context.mute.ready });
  items.push(
    { id: "close", label: "Close" },
    { id: "close-others", label: "Close others", disabled: context.count <= 1 },
    { id: "close-to-right", label: "Close to the right", disabled: context.index >= context.count - 1 },
    { id: "close-all", label: "Close all", disabled: context.count === 0 },
  );
  return items;
}

const isWindowsAbsolute = (path: string) => /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("//");

/** formatFilePathForClipboard: the file host's path style decides the separators. */
export function formatFilePathForClipboard(path: string, hostPath = path): string {
  return isWindowsAbsolute(hostPath) ? path.replaceAll("/", "\\") : path;
}

/** copyRightPanelFilePath: the tab's workspace-relative path, in the host's separators (the host path is the path joined to the project folder). */
export function clipboardPathFor(relativePath: string, cwd: string): string {
  return formatFilePathForClipboard(relativePath, resolvePathLinkTarget(relativePath, cwd));
}
