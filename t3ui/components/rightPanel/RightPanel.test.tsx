import { expect, open, test } from "nsh/test";
import { webViewLive } from "../terminal/webviewLive";

const size = { width: 1280, height: 800, platform: "macos" } as const;
// The Ghostty terminal is a WebView page (see components/terminal/webviewLive.ts); the headless
// engine never loads it, so a real second/third terminal never reports ready. Those checks only
// run in a real window: nsh test <file> --target macos.
const live = await webViewLive("../terminal/WebViewLiveProbe.tsx");
const windowed = live ? test : test.skip;

test("the header shows the project / title breadcrumb and the three panel toggles", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.waitFor("label:Thread breadcrumb");
  await expect(app.shows("text:demo")).toBe(true);
  await expect(app.shows("text:/")).toBe(true);
  await expect(app.shows("text:Fix the build")).toBe(true);
  for (const label of ["Toggle thread details panel", "Toggle terminal drawer", "Toggle right panel"]) {
    await expect(app.shows(`label:${label}`)).toBe(true);
  }
  await expect(app.shows("label:Workspace panel")).toBe(false);
});

test("the project name starts a new thread in that project", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:New thread in demo");
  await expect(app.texts().join("|")).toContain("new-thread:project-1");
});

test("the title menu renames the thread: Enter commits, empty is refused", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Thread actions for Fix the build");
  await app.press("label:Rename thread");
  await app.waitFor("label:Thread title");
  await app.clear("label:Thread title");
  await app.type("label:Thread title", "Ship it");
  await app.keyboard.press("enter");
  await app.waitFor("text:Ship it");
  await expect(app.texts().join("|")).toContain("rename:Ship it");
  await app.press("label:Thread actions for Ship it");
  await app.press("label:Rename thread");
  await app.waitFor("label:Thread title");
  await app.clear("label:Thread title");
  await app.keyboard.press("enter");
  await app.waitFor("text:Thread title cannot be empty");
});

test("the title menu is the sidebar's thread menu: rename, mark unread, copy, project settings, archive, delete", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Thread actions for Fix the build");
  for (const label of ["Rename thread", "Mark unread", "Copy", "Project settings", "Archive thread", "Delete"]) {
    await app.waitFor(`label:${label}`);
  }
  // Pin and settle need a connected environment, as in the sidebar menu.
  await expect(app.shows("label:Pin thread")).toBe(false);
});

test("right-clicking the breadcrumb opens the same thread menu", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.rightClick("text:Plan the work");
  await app.waitFor("label:Archive thread");
  await expect(app.shows("label:Rename thread")).toBe(true);
});

test("toggling the right panel shows the launcher, and Files opens a tree tab", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle right panel");
  await app.waitFor("label:Open a surface");
  await expect(app.shows("label:Terminal")).toBe(true);
  await expect(app.shows("label:Diff")).toBe(true);
  await app.press("label:Files");
  await app.waitFor("label:Select Files");
  await app.waitFor("label:src");
  await expect(app.texts().join("|")).toContain("projects.listEntries:");
  await app.press("label:readme.md");
  await app.waitFor("label:Select readme.md");
  await app.waitFor("text:hello");
  await app.press("label:Close readme.md");
  await expect(app.shows("label:Select readme.md")).toBe(false);
});

test("the + menu adds the Diff tab and the tab strip closes it", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle right panel");
  await app.press("label:Add panel surface");
  await app.press("label:Add Diff");
  await app.waitFor("label:Select Diff");
  await app.waitFor("label:Diff scope: Changes");
  await app.press("label:Close Diff");
  await app.waitFor("label:Open a surface");
});

test("the right panel can be maximized and restored, and the controls move into its tab bar", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle right panel");
  await app.press("label:Files");
  await app.waitFor("label:Maximize panel");
  await app.press("label:Maximize panel");
  await app.waitFor("label:Restore panel size");
  await app.press("label:Restore panel size");
  await app.waitFor("label:Maximize panel");
  await app.press("label:Toggle right panel");
  await app.waitFor("label:Workspace panel", { state: "gone" });
});

windowed("the terminal drawer toggles and its chrome creates, splits and closes terminals", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle terminal drawer");
  await app.waitFor("label:Terminal drawer");
  await expect(app.shows("label:New Terminal")).toBe(true);
  await expect(app.shows("label:Split Terminal Horizontally")).toBe(true);
  await expect(app.shows("label:Split Terminal Vertically")).toBe(true);
  await expect(app.shows("label:Close Terminal")).toBe(true);
  await app.press("label:New Terminal");
  await app.waitFor("label:Terminals");
  await expect(app.shows("label:Terminal 1")).toBe(true);
  await expect(app.shows("label:Terminal 2")).toBe(true);
  await app.press("label:Close Terminal 2");
  await app.waitFor("label:Terminals", { state: "gone" });
  await app.press("label:Close Terminal");
  await app.waitFor("text:No terminal sessions for this thread yet.");
  await expect(app.texts().join("|")).toContain("terminal.close:term-2");
  await app.press("label:New Terminal");
  await app.waitFor("label:Terminal drawer");
  await app.press("label:Toggle terminal drawer");
  await app.waitFor("label:Terminal drawer", { state: "gone" });
});

test("the thread details toggle opens the card", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle thread details panel");
  await app.waitFor("label:Thread details");
  await app.press("label:Toggle thread details panel");
  await app.waitFor("label:Thread details", { state: "gone" });
});

function tabOrder(app: { storage(): Record<string, string> }): string[] {
  const saved = JSON.parse(app.storage().rightPanels ?? "{}")["fixture-thread"];
  return (saved?.surfaces ?? []).map((surface: { id: string }) => surface.id);
}

test("a tab dragged past its neighbour changes places with it", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle right panel");
  await app.waitFor("label:Files");
  await app.press("label:Files");
  await app.waitFor("label:Add panel surface");
  await app.press("label:Add panel surface");
  await app.waitFor("label:Add Diff");
  await app.press("label:Add Diff");
  await app.waitFor("label:Select Diff");
  await expect(tabOrder(app)).toEqual(["files", "diff"]);
  await app.drag("label:Select Diff", { x: -60 });
  await app.waitUntil(() => tabOrder(app)[0] === "diff");
  await expect(tabOrder(app)).toEqual(["diff", "files"]);
});

test("a short tab drag leaves the order alone", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle right panel");
  await app.waitFor("label:Files");
  await app.press("label:Files");
  await app.waitFor("label:Add panel surface");
  await app.press("label:Add panel surface");
  await app.waitFor("label:Add Diff");
  await app.press("label:Add Diff");
  await app.waitFor("label:Select Diff");
  await app.drag("label:Diff", { x: -8 });
  await app.wait(100);
  await expect(tabOrder(app)).toEqual(["files", "diff"]);
});

test("the resize edge tracks the pointer while it is held, and stores the width on release", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle right panel");
  await app.waitFor("label:Resize right panel");
  await app.waitFor("text:panel-width:540");
  await app.drag("label:Resize right panel", { x: -100 });
  await app.wait(50);
  await app.waitFor("text:panel-width:640");
  await expect(JSON.parse(app.storage().rightPanels ?? "{}")["fixture-thread"]?.width).toBe(640);
});

test("a narrow window shows the panel as a sheet over the chat", async () => {
  const app = await open("./WorkspaceFixture.tsx", { width: 900, height: 700, platform: "macos" });
  await app.press("label:Toggle right panel");
  await app.waitFor("label:Open a surface");
  await app.waitFor("label:Workspace panel");
  await expect(app.shows("label:Resize right panel")).toBe(false);
  await expect(app.shows("label:Maximize panel")).toBe(false);
});

test("the terminal drawer's top edge tracks the pointer while it is held, and stores the height on release", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle terminal drawer");
  await app.waitFor("label:Resize terminal drawer");
  await app.waitFor("text:drawer-height:280");
  await app.drag("label:Resize terminal drawer", { y: -60 });
  await app.wait(50);
  await app.waitFor("text:drawer-height:340");
  await expect(JSON.parse(app.storage().terminalDrawers ?? "{}")["fixture-thread"]?.height).toBe(340);
});

windowed("the terminal command handlers split, add and close terminals, and wait for the drawer to be open", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Run terminal.new");
  await expect(app.shows("label:Terminal drawer")).toBe(false);
  await app.press("label:Toggle terminal drawer");
  await app.waitFor("label:Terminal drawer");
  await app.press("label:Run terminal.split");
  await app.waitFor("label:Terminal 2");
  await app.press("label:Run terminal.splitVertical");
  await app.waitFor("label:Terminal 3");
  await app.press("label:Run terminal.new");
  await app.waitFor("label:Terminal 4");
  await app.press("label:Run terminal.close");
  await app.waitFor("label:Terminal 4", { state: "gone" });
  await expect(app.texts().join("|")).toContain("terminal.close:term-4");
});

test("the header links the parent thread, badges the link origin and ends a guest share", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.waitFor("label:Open parent thread: Plan the work");
  await expect(app.shows("text:From Work Mac")).toBe(true);
  await expect(app.shows("text:Ada is a guest")).toBe(true);
  await app.press("label:Open parent thread: Plan the work");
  await expect(app.texts().join("|")).toContain("open-thread:parent-1");
  await app.press("label:Stop sharing");
  await app.waitFor("label:Guest share", { state: "gone" });
  await expect(app.texts().join("|")).toContain("stop-share:thread-1");
});

test("rightPanel.close closes the active tab, then hides the panel", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle right panel");
  await app.press("label:Files");
  await app.waitFor("label:Select Files");
  await app.press("label:Run rightPanel.close");
  await app.waitFor("label:Select Files", { state: "gone" });
  await app.waitFor("label:Open a surface");
  await app.press("label:Run rightPanel.close");
  await app.waitFor("label:Workspace panel", { state: "gone" });
});

test("the launcher lists the web's surfaces in its order", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle right panel");
  await app.waitFor("label:Open a surface");
  for (const label of ["Browser", "Terminal", "Files", "Diff", "Pull request", "Linked pull requests"]) {
    await expect(app.shows(`label:${label}`)).toBe(true);
  }
  await expect(app.shows("label:Side chat")).toBe(false);
});

windowed("the launcher's Terminal opens a terminal tab in the panel", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle right panel");
  await app.press("label:Terminal");
  // term-1 belongs to the drawer's first terminal, so the tab takes the next id.
  await app.waitFor("label:Select Terminal 2");
  await app.waitFor("label:Terminal tab");
  await app.press("label:Close Terminal 2");
  await expect(app.shows("label:Terminal tab")).toBe(false);
});

test("the launcher's Browser opens a browser tab whose address bar names the tab", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle right panel");
  await app.press("label:Browser");
  await app.waitFor("label:Select Browser");
  await app.waitFor("text:No preview yet");
  await app.type("label:Search or enter URL", "localhost:3000");
  await app.keyboard.press("enter");
  await app.waitFor("label:Select localhost:3000");
});

test("the title menu offers Find in thread and runs chat.find", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Thread actions for Fix the build");
  await app.press("label:Find in thread");
  await expect(app.texts().join("|")).toContain("chat.find");
});

test("opening the + menu over a browser page hides the native web view and restores it on close", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle right panel");
  await app.press("label:Browser");
  await app.waitFor("text:No preview yet");
  await app.type("label:Search or enter URL", "localhost:3000");
  await app.keyboard.press("enter");
  await app.waitFor("label:Select localhost:3000");
  await expect(app.shows("label:Browser page hidden behind an open menu")).toBe(false);
  await app.press("label:Add panel surface");
  await app.waitFor("label:Add Terminal");
  await expect(app.shows("label:Browser page hidden behind an open menu")).toBe(true);
  await app.keyboard.press("escape");
  await app.waitFor("label:Browser page hidden behind an open menu", { state: "gone" });
  await expect(app.shows("label:Browser page hidden behind an open menu")).toBe(false);
});

test("the browser's more menu offers Hard reload and zoom, and zooming shows the pill", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle right panel");
  await app.press("label:Browser");
  await app.type("label:Search or enter URL", "localhost:3000");
  await app.keyboard.press("enter");
  await app.waitFor("label:Select localhost:3000");
  await app.press("label:Preview menu");
  await app.waitFor("label:Hard reload");
  await expect(app.shows("label:Reset zoom")).toBe(true);
  await app.press("label:Zoom in");
  await app.waitFor("text:110%");
  // fm13: Reset zoom is its own button after Zoom in (PreviewMoreMenu.tsx:151-160).
  await app.press("label:Reset zoom");
  await app.waitFor("text:100%");
});

test("a visited page comes back as a Recently used card in the next empty browser tab", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle right panel");
  await app.press("label:Browser");
  await app.type("label:Search or enter URL", "localhost:4321");
  await app.keyboard.press("enter");
  await app.waitFor("label:Select localhost:4321");
  await app.press("label:Close localhost:4321");
  await app.press("label:Browser");
  await app.waitFor("label:Recently used");
  await app.waitFor("label:Open localhost:4321");
  await app.press("label:Remove localhost:4321 from history");
  await app.waitFor("text:No preview yet");
});

test("the + menu's Browser row opens a tab and closes the menu; unavailable rows stay listed", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle right panel");
  await app.press("label:Add panel surface");
  await app.waitFor("label:Add Browser");
  for (const label of ["Add Pull request", "Add Linked pull requests", "Add Files", "Add Diff"]) await expect(app.shows(`label:${label}`)).toBe(true);
  await app.press("label:Add Browser");
  await app.waitFor("label:Select Browser");
  await app.waitFor("label:Add Browser", { state: "gone" });
});

test("tabs that overflow the strip show the Scroll tabs chevrons; the tab strip shares the header row with the panel controls", async () => {
  const app = await open("./WorkspaceFixture.tsx", { width: 1280, height: 700, platform: "macos" });
  await app.press("label:Toggle right panel");
  await app.waitFor("label:Right panel tabs");
  await expect(app.shows("label:Scroll tabs right")).toBe(false);
  for (let index = 0; index < 8; index += 1) {
    // The default 540pt panel started dropping "Add panel surface" from the accessibility tree
    // entirely at 6 simultaneous tabs (not just scrolling it offscreen): assert it is still there,
    // at every count, the same way the reference keeps it inside the scrollable tab row.
    await expect(app.shows("label:Add panel surface")).toBe(true);
    await app.press("label:Add panel surface");
    await app.waitFor("label:Add Browser");
    await app.press("label:Add Browser");
    await app.waitFor("label:Add Browser", { state: "gone" });
    await app.waitUntil(() => app.texts().filter((text) => text === "Browser").length >= 1);
  }
  await expect(app.shows("label:Add panel surface")).toBe(true);
  await app.waitFor("label:Scroll tabs right");
  await expect(app.shows("label:Scroll tabs left")).toBe(true);
  await expect(app.shows("label:Toggle right panel")).toBe(true);
});

test("a letter on the launcher opens its surface, as the reference's capture-phase shortcuts do", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle right panel");
  await app.waitFor("label:Open a surface");
  await app.keyboard.press("t");
  await app.waitFor("label:Terminal tab");
});

test("without the preview operate scope a browser tab shows the pairing message and no page", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle right panel");
  await app.press("label:Browser");
  await app.waitFor("label:Search or enter URL");
  await app.press("label:Deny preview scope");
  await app.waitFor("text:Pair this client again with preview access to control browser previews.");
  await expect(app.shows("label:Search or enter URL")).toBe(false);
});

test("Show device toolbar adds the viewport toolbar to a loaded page, and Close device toolbar removes it", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle right panel");
  await app.press("label:Browser");
  await app.type("label:Search or enter URL", "localhost:3000");
  await app.keyboard.press("enter");
  await app.waitFor("label:Select localhost:3000");
  await app.press("label:Preview menu");
  await app.press("label:Show device toolbar");
  await app.waitFor("label:Browser device toolbar");
  await expect(app.shows("label:Viewport width")).toBe(true);
  await expect(app.shows("label:Rotate viewport")).toBe(true);
  await app.press("label:Close device toolbar");
  await expect(app.shows("label:Browser device toolbar")).toBe(false);
});

test("a row's letter opens it while the add menu is open, and closes the menu (handleAddSurfaceMenuKeyDown)", async () => {
  const app = await open("./WorkspaceFixture.tsx", size);
  await app.press("label:Toggle right panel");
  await app.press("label:Files");
  await app.press("label:Add panel surface");
  await app.waitFor("label:Add Diff");
  await app.keyboard.press("d");
  await app.waitFor("label:Select Diff");
  await expect(tabOrder(app)).toEqual(["files", "diff"]);
  await expect(app.shows("label:Add Diff")).toBe(false);
});
