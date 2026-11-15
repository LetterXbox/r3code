// The terminal page's menus and links as the app runs them: the page reports a pointer and a selection, the app opens its own menu.
import { expect, open, test } from "nsh/test";
import { terminalContextMenuItems, terminalSelectionMenuItems } from "./terminalPageBridge";

const logOf = (app: Awaited<ReturnType<typeof open>>) => app.texts().find((text) => text.startsWith("log=[")) ?? "";

test("the right-click menu has the reference's five items, the selection's two disabled without a selection", () => {
  expect(terminalContextMenuItems({ hasSelection: true, canAddToChat: true })).toEqual([
    { id: "add-to-chat", label: "Add to chat", disabled: false }, { id: "copy", label: "Copy", disabled: false },
    { id: "paste", label: "Paste" }, { id: "select-all", label: "Select all" }, { id: "scroll-to-bottom", label: "Jump to latest" },
  ]);
  const bare = terminalContextMenuItems({ hasSelection: false, canAddToChat: false });
  expect(bare.map((item) => item.label)).toEqual(["Copy", "Paste", "Select all", "Jump to latest"]);
  expect(bare[0]?.disabled).toBe(true);
  expect(terminalSelectionMenuItems({ canAddToChat: true }).map((item) => item.label)).toEqual(["Add to chat", "Copy"]);
  expect(terminalSelectionMenuItems({ canAddToChat: false }).map((item) => item.label)).toEqual(["Copy"]);
});

test("a right click in the page opens the app's menu, and Select all and Jump to latest go back to the page", async () => {
  const app = await open("./TerminalBridgeFixture.tsx", { width: 600, height: 400, platform: "macos" });
  await app.rightClick("text:Right click with selection");
  await app.waitUntil(() => app.menu() !== null);
  expect((app.menu() ?? []).map((entry) => entry.label)).toEqual(["Add to chat", "Copy", "Paste", "Select all", "Jump to latest"]);
  await app.chooseMenuItem("Select all");
  await app.waitUntil(() => logOf(app).includes('menu-action'));
  await expect(logOf(app)).toContain('post:{"type":"menu-action","action":"select-all"}');
  await app.rightClick("text:Right click without selection");
  await app.waitUntil(() => app.menu() !== null);
  await app.chooseMenuItem("Jump to latest");
  await app.waitUntil(() => logOf(app).includes("scroll-to-bottom"));
  // Each menu action hands the keyboard back to the terminal.
  await expect(logOf(app)).toContain("focus");
});

test("Add to chat asks the page for the selection of now and only then puts it in the composer", async () => {
  const app = await open("./TerminalBridgeFixture.tsx", { width: 600, height: 400, platform: "macos" });
  await app.rightClick("text:Selection finished");
  await app.waitUntil(() => app.menu() !== null);
  expect((app.menu() ?? []).map((entry) => entry.label)).toEqual(["Add to chat", "Copy"]);
  await app.chooseMenuItem("Add to chat");
  await app.waitUntil(() => logOf(app).includes("add-to-chat-request"));
  await expect(logOf(app)).not.toContain("chat:");
  await app.press("label:Page answers add to chat");
  await app.waitUntil(() => logOf(app).includes("chat:"));
  await expect(logOf(app)).toContain("chat:Terminal 2|3-4|error: boom/at main");
  await expect(logOf(app)).toContain('"action":"clear-selection"');
});

test("a file path link is checked with filesystem.getMetadata and opened in the preferred editor at its line and column", async () => {
  const app = await open("./TerminalBridgeFixture.tsx", { width: 600, height: 400, platform: "macos" });
  await app.press("label:Check path");
  await app.waitUntil(() => logOf(app).includes("link-checked"));
  await expect(logOf(app)).toContain('rpc:filesystem.getMetadata:{"paths":["/repo/src/a.ts"]}');
  await expect(logOf(app)).toContain('post:{"type":"link-checked","id":7,"valid":true}');
  await app.press("label:Open path");
  await app.waitUntil(() => logOf(app).includes("shell.openInEditor"));
  await expect(logOf(app)).toContain('rpc:shell.openInEditor:{"cwd":"/repo/src/a.ts:12:3","editor":"vscode"}');
});

test("a web link opens in the system browser while the link target setting is the default", async () => {
  const app = await open("./TerminalBridgeFixture.tsx", { width: 600, height: 400, platform: "macos" });
  await app.press("label:Open link");
  await app.waitUntil(() => app.openedUrls().length > 0);
  expect(app.openedUrls()).toEqual(["https://example.com/x"]);
});

test("Copy puts the selection's text on the clipboard and Paste sends the clipboard's text to the page", async () => {
  const app = await open("./TerminalBridgeFixture.tsx", { width: 600, height: 400, platform: "macos" });
  await app.rightClick("text:Selection finished");
  await app.waitUntil(() => app.menu() !== null);
  await app.chooseMenuItem("Copy");
  await app.press("label:Read clipboard");
  await app.waitUntil(() => logOf(app).includes("clipboard:error: boom"));
  await app.press("label:Fill clipboard");
  await app.waitUntil(() => logOf(app).includes("clipboard:filled"));
  await app.rightClick("text:Right click without selection");
  await app.waitUntil(() => app.menu() !== null);
  await app.chooseMenuItem("Paste");
  await app.waitUntil(() => logOf(app).includes('"type":"paste"'));
  await expect(logOf(app)).toContain('post:{"type":"paste","text":"echo hi"}');
});

test("the selection menu closes when its terminal leaves the screen, without pulling the keyboard back, and none opens while it is away", async () => {
  const app = await open("./TerminalBridgeFixture.tsx", { width: 600, height: 400, platform: "macos" });
  await app.rightClick("text:Selection finished");
  await app.waitUntil(() => (app.menu() ?? []).length === 2);
  // A tab switch, the panel closing or a thread switch: the open menu is replaced by an empty one, which closes it.
  await app.press("label:Leave screen");
  await app.waitUntil(() => (app.menu() ?? [{}]).length === 0);
  await expect(logOf(app)).not.toContain("focus");
  // A selection gesture that ends after the terminal left (a double click's wait) opens nothing.
  await app.rightClick("text:Selection finished");
  await app.rightClick("text:Right click with selection");
  await app.press("label:Fill clipboard");
  await app.waitUntil(() => logOf(app).includes("clipboard:filled"));
  expect((app.menu() ?? []).length).toBe(0);
  // Back on screen the menus work again.
  await app.press("label:Return to screen");
  await app.rightClick("text:Selection finished");
  await app.waitUntil(() => (app.menu() ?? []).length === 2);
  expect((app.menu() ?? []).map((entry) => entry.label)).toEqual(["Add to chat", "Copy"]);
});
