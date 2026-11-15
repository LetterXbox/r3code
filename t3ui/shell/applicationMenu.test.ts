// The application menu against DesktopApplicationMenu.ts: six menus on macOS (app, File, Edit, View, Window, Help), labels, order, separators and
// accelerators, and every non-role item running a command of the registry.
import { expect, test } from "nsh/test";
import type { MenuItem } from "nsh/desktop";
import { APP_COMMAND } from "../commands/appCommands";
import { buildApplicationMenu, parseHostMenuRoles } from "./applicationMenu";

function build(os: string) {
  const ran: string[] = [];
  const menus = buildApplicationMenu({ os, run: (id) => { ran.push(id); }, openSettings: () => { ran.push("settings"); }, quit: () => { ran.push("quit"); } });
  return { menus, ran };
}

/** One line per item: separators as "-", roles as "role:x", labelled items with their shortcut. */
function outline(items: readonly MenuItem[]): string[] {
  return items.map((item) => {
    if ("type" in item && item.type === "separator") return "-";
    const entry = item as Exclude<MenuItem, { type: "separator" }>;
    if (entry.role && !entry.label) return `role:${entry.role}`;
    return `${entry.label}${entry.shortcut ? ` [${entry.shortcut}]` : ""}${entry.disabled ? " (disabled)" : ""}${entry.role ? ` role:${entry.role}` : ""}`;
  });
}

const press = (items: readonly MenuItem[], label: string) => {
  const item = items.find((entry) => "label" in entry && entry.label === label) as Exclude<MenuItem, { type: "separator" }> | undefined;
  expect(item).toBeDefined();
  item!.onSelect?.();
};

test("macOS lists the app menu, File, Edit, View, Window and Help, in the reference's order", () => {
  const { menus } = build("macos");
  expect(menus.map((menu) => menu.label)).toEqual(["R3 Code", "File", "Edit", "View", "Window", "Help"]);
});

test("the app menu: About, Check for Updates..., Settings..., Hide items, Quit, with the separators between", () => {
  const { menus } = build("macos");
  expect(outline(menus[0]!.submenu)).toEqual([
    "About R3 Code role:about", "Check for Updates...", "-", "Settings... [mod+,]", "-",
    "Hide R3 Code role:hide", "role:hideOthers", "role:showAll", "-", "Quit R3 Code [mod+q]",
  ]);
});

test("File has Close Window on macOS; elsewhere Settings and Quit", () => {
  expect(outline(build("macos").menus[1]!.submenu)).toEqual(["Close Window"]);
  const other = build("linux").menus;
  expect(other.map((menu) => menu.label)).toEqual(["File", "Edit", "View", "Window", "Help"]);
  expect(outline(other[0]!.submenu)).toEqual(["Settings... [mod+,]", "-", "Quit [mod+q]"]);
});

test("Edit has Paste as Text on Shift+Cmd+V between Paste and Select All", () => {
  expect(outline(build("macos").menus[2]!.submenu)).toEqual([
    "role:undo", "role:redo", "-", "role:cut", "role:copy", "role:paste", "Paste as Text [mod+shift+v]", "-", "role:selectAll",
  ]);
});

test("View has Reload, Force Reload, Developer Tools, the zoom items and full screen", () => {
  expect(outline(build("macos").menus[3]!.submenu)).toEqual([
    "Reload [mod+r]", "Force Reload [mod+shift+r]", "Toggle Developer Tools [alt+cmd+i] (disabled)", "-",
    "Actual Size [mod+0]", "Zoom In [mod+plus]", "Zoom Out [mod+minus]", "-", "role:toggleFullScreen",
  ]);
  expect(outline(build("windows").menus[2]!.submenu)).toContain("Toggle Developer Tools [ctrl+shift+i] (disabled)");
});

test("Window and Help", () => {
  const { menus } = build("macos");
  expect(outline(menus[4]!.submenu)).toEqual(["role:minimize", "role:zoom"]);
  expect(outline(menus[5]!.submenu)).toEqual(["Check for Updates..."]);
});

test("every item that is not a role runs a command of the registry", () => {
  const { menus, ran } = build("macos");
  press(menus[0]!.submenu, "Check for Updates...");
  press(menus[0]!.submenu, "Settings...");
  press(menus[0]!.submenu, "Quit R3 Code");
  press(menus[1]!.submenu, "Close Window");
  press(menus[2]!.submenu, "Paste as Text");
  press(menus[3]!.submenu, "Reload");
  press(menus[3]!.submenu, "Force Reload");
  press(menus[3]!.submenu, "Actual Size");
  press(menus[3]!.submenu, "Zoom In");
  press(menus[3]!.submenu, "Zoom Out");
  press(menus[5]!.submenu, "Check for Updates...");
  expect(ran).toEqual([
    APP_COMMAND.checkForUpdates, "settings", "quit", APP_COMMAND.closeWindow, APP_COMMAND.pasteAsText, APP_COMMAND.reload, APP_COMMAND.forceReload,
    APP_COMMAND.zoomReset, APP_COMMAND.zoomIn, APP_COMMAND.zoomOut, APP_COMMAND.checkForUpdates,
  ]);
});

test("with patch 0014's roles: Services, Delete, Speech and Bring All to Front in the reference's places", () => {
  const hostRoles = parseHostMenuRoles(["services", "delete", "startSpeaking", "stopSpeaking", "front", "bogus"]);
  expect([...hostRoles].sort()).toEqual(["delete", "front", "services", "startSpeaking", "stopSpeaking"]);
  const menus = buildApplicationMenu({ os: "macos", run: () => {}, openSettings: () => {}, quit: () => {}, hostRoles });
  expect(outline(menus[0]!.submenu)).toEqual([
    "About R3 Code role:about", "Check for Updates...", "-", "Settings... [mod+,]", "-", "role:services", "-",
    "Hide R3 Code role:hide", "role:hideOthers", "role:showAll", "-", "Quit R3 Code [mod+q]",
  ]);
  const edit = menus[2]!.submenu;
  expect(outline(edit)).toEqual(["role:undo", "role:redo", "-", "role:cut", "role:copy", "role:paste", "Paste as Text [mod+shift+v]", "role:delete", "-", "role:selectAll", "-", "Speech"]);
  const speech = edit[edit.length - 1] as { submenu: MenuItem[] };
  expect(outline(speech.submenu)).toEqual(["role:startSpeaking", "role:stopSpeaking"]);
  expect(outline(menus[4]!.submenu)).toEqual(["role:minimize", "role:zoom", "-", "role:front"]);
  // Off macOS only Delete is added.
  const other = buildApplicationMenu({ os: "linux", run: () => {}, openSettings: () => {}, quit: () => {}, hostRoles });
  expect(outline(other.find((m) => m.label === "Edit")!.submenu)).toContain("role:delete");
  expect(outline(other.find((m) => m.label === "Window")!.submenu)).toEqual(["role:minimize", "role:zoom"]);
});

test("an older host (no menu.roles) gets none of patch 0014's roles", () => {
  expect(parseHostMenuRoles(undefined).size).toBe(0);
  const { menus } = build("macos");
  expect(JSON.stringify(menus)).not.toContain("services");
});
