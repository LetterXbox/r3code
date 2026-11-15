// The application menu, from apps/desktop/src/window/DesktopApplicationMenu.ts: the app menu (macOS), File, Edit, View, Window and Help, with the
// reference's labels, order, separators and accelerators. Every item that is not a platform role runs a command of the registry
// (commands/appCommands.ts), so the menu, the palette and the keymap share one implementation.
//
// The app menu's Services submenu, Edit's Delete and Speech (Start/Stop Speaking) and Window's Bring All to Front are roles of host patch
// 0014 (`menu.roles`): listed only when the host names them, since an older host rejects the whole menu for a role it does not know.
// The same host answers Command-Shift-= and the keypad's + with Zoom In (Electron's hidden twins; keypad 0 and - match the number row).
// Left out: the hidden Close Developer Tools twin (there are no developer tools).
// Toggle Developer Tools is listed but dimmed: the runtime has no developer tools to open.
import type { MenuItem } from "nsh/desktop";
import { APP_COMMAND } from "../commands/appCommands";

export interface ApplicationMenuInput {
  /** "macos" lists the app menu and Close Window; any other value lists Settings and Quit under File. */
  os: string;
  displayName?: string;
  /** Runs a command of the registry by id. */
  run: (command: string) => void;
  /** Settings... (the page toggles; the menu item is the web's `open-settings` menu action). */
  openSettings: () => void;
  /** Quit: the quit shortcut's confirmation (shell/quitHold.ts). */
  quit: () => void;
  /** The extra roles the host knows (`menu.roles`, patch 0014); none by default. */
  hostRoles?: ReadonlySet<string>;
}

/** The roles of patch 0014; NSH's generated `MenuRole` predates them. */
export const HOST_MENU_ROLES = ["services", "delete", "startSpeaking", "stopSpeaking", "front"] as const;
type HostMenuRole = (typeof HOST_MENU_ROLES)[number];

/** `menu.roles`' answer as a set of the roles this module uses. */
export function parseHostMenuRoles(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.filter((r): r is HostMenuRole => (HOST_MENU_ROLES as readonly unknown[]).includes(r)) : []);
}

export interface ApplicationMenuTemplate { label: string; submenu: MenuItem[] }

const SEPARATOR: MenuItem = { type: "separator" };

/** Collapses doubled separators and trims the ends, so an omitted item leaves no empty gap. */
export function tidy(items: readonly MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const item of items) {
    const isSeparator = "type" in item && item.type === "separator";
    if (isSeparator && (out.length === 0 || ("type" in out[out.length - 1]! && (out[out.length - 1] as { type?: string }).type === "separator"))) continue;
    out.push(item);
  }
  while (out.length > 0 && "type" in out[out.length - 1]! && (out[out.length - 1] as { type?: string }).type === "separator") out.pop();
  return out;
}

export function buildApplicationMenu(input: ApplicationMenuInput): ApplicationMenuTemplate[] {
  const mac = input.os === "macos";
  const name = input.displayName ?? "R3 Code";
  const command = (id: string) => () => input.run(id);
  const roles = input.hostRoles ?? new Set<string>();
  const hostRole = (role: HostMenuRole, extra: Record<string, unknown> = {}): MenuItem | null =>
    roles.has(role) ? ({ role, ...extra } as unknown as MenuItem) : null;
  const present = (items: (MenuItem | null)[]): MenuItem[] => items.filter((item): item is MenuItem => item !== null);
  const menus: ApplicationMenuTemplate[] = [];

  if (mac) {
    menus.push({
      label: name,
      submenu: tidy([
        { role: "about", label: `About ${name}` },
        { label: "Check for Updates...", onSelect: command(APP_COMMAND.checkForUpdates) },
        SEPARATOR,
        { label: "Settings...", shortcut: "mod+,", onSelect: input.openSettings },
        SEPARATOR,
        ...present([hostRole("services")]),
        SEPARATOR,
        { role: "hide", label: `Hide ${name}` },
        { role: "hideOthers" },
        // Electron's `unhide` is macOS's Show All.
        { role: "showAll" },
        SEPARATOR,
        { label: `Quit ${name}`, shortcut: "mod+q", onSelect: input.quit },
      ]),
    });
  }

  menus.push(
    {
      label: "File",
      submenu: tidy([
        ...(mac ? [] : [{ label: "Settings...", shortcut: "mod+,", onSelect: input.openSettings } as MenuItem, SEPARATOR]),
        // Cmd/Ctrl+W belongs to the tab close; Close Window never takes it.
        mac ? { label: "Close Window", onSelect: command(APP_COMMAND.closeWindow) } : { label: "Quit", shortcut: "mod+q", onSelect: input.quit },
      ]),
    },
    {
      label: "Edit",
      submenu: tidy([
        { role: "undo" },
        { role: "redo" },
        SEPARATOR,
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        // Where a text field uses the chord itself (a native paste), the field keeps it.
        { label: "Paste as Text", shortcut: "mod+shift+v", when: "auto", onSelect: command(APP_COMMAND.pasteAsText) },
        ...present([hostRole("delete")]),
        SEPARATOR,
        { role: "selectAll" },
        ...(mac && roles.has("startSpeaking") && roles.has("stopSpeaking")
          ? [SEPARATOR, { label: "Speech", submenu: present([hostRole("startSpeaking"), hostRole("stopSpeaking")]) } as MenuItem]
          : []),
      ]),
    },
    {
      label: "View",
      submenu: tidy([
        { label: "Reload", shortcut: "mod+r", onSelect: command(APP_COMMAND.reload) },
        { label: "Force Reload", shortcut: "mod+shift+r", onSelect: command(APP_COMMAND.forceReload) },
        { label: "Toggle Developer Tools", shortcut: mac ? "alt+cmd+i" : "ctrl+shift+i", disabled: true },
        SEPARATOR,
        { label: "Actual Size", shortcut: "mod+0", onSelect: command(APP_COMMAND.zoomReset) },
        { label: "Zoom In", shortcut: "mod+plus", onSelect: command(APP_COMMAND.zoomIn) },
        { label: "Zoom Out", shortcut: "mod+minus", onSelect: command(APP_COMMAND.zoomOut) },
        SEPARATOR,
        { role: "toggleFullScreen" },
      ]),
    },
    {
      label: "Window",
      submenu: tidy([{ role: "minimize" }, { role: "zoom" }, ...(mac ? present([SEPARATOR, hostRole("front")]) : [])]),
    },
    {
      label: "Help",
      submenu: [{ label: "Check for Updates...", onSelect: command(APP_COMMAND.checkForUpdates) }],
    },
  );
  return menus;
}
