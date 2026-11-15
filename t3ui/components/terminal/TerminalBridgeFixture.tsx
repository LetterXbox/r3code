// The app's half of the terminal page's menus and links, driven with the messages the page sends (terminalPageBridge.ts).
import { Clipboard, mount, signal, Text, View } from "nsh";
import { createTerminalPageBridge } from "./terminalPageBridge";

const log = signal<string[]>([]);
const add = (line: string) => log.update((all) => [...all, line]);

const onScreen = signal(true);
const selection = { text: "error: boom\nat main", clipboardText: "error: boom\r\nat main\r\n", lineStart: 3, lineEnd: 4 };

const bridge = createTerminalPageBridge({
  terminalId: "term-2",
  cwd: () => "/repo",
  post: (message) => add(`post:${JSON.stringify(message)}`),
  origin: async () => ({ x: 100, y: 50 }),
  label: () => "Terminal 2",
  addToChat: (taken) => { add(`chat:${taken.terminalLabel}|${taken.lineStart}-${taken.lineEnd}|${taken.text.replace(/\n/g, "/")}`); return true; },
  focusPage: () => add("focus"),
  notice: (text) => add(`notice:${text}`),
  onScreen: () => onScreen(),
  rpc: async (method, payload) => {
    add(`rpc:${method}:${JSON.stringify(payload)}`);
    if (method === "filesystem.getMetadata") return { entries: [{ kind: "file" }] };
    if (method === "server.getConfig") return { availableEditors: ["vscode"] };
    return null;
  },
});

const buttons: [string, () => void][] = [
  ["Fill clipboard", () => { void Clipboard.writeText("echo hi").then(() => add("clipboard:filled")); }],
  ["Read clipboard", () => { void Clipboard.readText().then((text) => add(`clipboard:${text}`)); }],
  ["Right click with selection", () => bridge.handle({ type: "contextmenu", x: 12, y: 34, selection })],
  ["Right click without selection", () => bridge.handle({ type: "contextmenu", x: 12, y: 34, selection: null })],
  ["Selection finished", () => bridge.handle({ type: "selection-action", x: 20, y: 40, selection })],
  ["Page answers add to chat", () => bridge.handle({ type: "add-to-chat-selection", selection })],
  // What TerminalPane does when its tab, panel or thread is no longer the one on screen.
  ["Leave screen", () => { onScreen.set(false); bridge.dismissMenu(); }],
  ["Return to screen", () => onScreen.set(true)],
  ["Check path", () => bridge.handle({ type: "link-check", id: 7, text: "src/a.ts:12:3" })],
  ["Open path", () => bridge.handle({ type: "open-path", text: "src/a.ts:12:3" })],
  ["Open link", () => bridge.handle({ type: "open-link", url: "https://example.com/x", forceBrowser: false })],
];

mount(() => (
  <View class="flex-1 bg-background">
    {buttons.map(([label, run]) => <View role="button" accessibilityLabel={label} onPress={run} onContextMenu={run}><Text>{label}</Text></View>)}
    <Text>{`log=[${log().join(" ; ")}]`}</Text>
  </View>
));
