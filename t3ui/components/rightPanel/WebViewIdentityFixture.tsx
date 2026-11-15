// The right panel and the terminal drawer over two made-up threads, with a count of how often each native web view
// was made (webViewMounts.ts) and buttons for what a test cannot reach through the panel itself: switching threads,
// choosing the host kind (web views above or under the app's surface), and opening an overlay.
import { mount, signal, Text, View, windowSize } from "nsh";
import { closeSettings, openSettings } from "../../store";
import { TerminalDrawer } from "../terminal/TerminalDrawer";
import { updateDrawer } from "../terminal/drawerState";
import { overrideTerminalDocument } from "../terminal/terminalDocument";
import { RightPanel } from "./RightPanel";
import { overrideWebViewsUnderSurface, registerOverlay } from "./nativeOcclusion";
import { currentPanelKey, overridePanelContext, panelStateFor, setPreviewUrlAction, splitPanelTerminalAction, toggleMaximizedAction, toggleRightPanelAction, toggleTerminalAction } from "./panelState";
import { overridePreviewScope } from "./previewScope";
import { webViewMounts } from "./webViewMounts";

overridePreviewScope("granted");
overrideTerminalDocument("<!doctype html><html><body>terminal</body></html>");
const threads = {
  one: { key: "fixture-thread-1", workspace: { threadId: "thread-1", cwd: "/project" } },
  two: { key: "fixture-thread-2", workspace: { threadId: "thread-2", cwd: "/project" } },
};
overridePanelContext(threads.one);

const width = signal(0);
let release: (() => void) | null = null;
const overlay = signal(false);
async function rpc(): Promise<unknown> { return undefined; }
const button = (label: string, onPress: () => void) => <View accessibilityLabel={label} role="button" onPress={onPress}><Text>{label}</Text></View>;

mount(() => (
  <View class="flex-1 bg-background">
    <View class="min-h-0 flex-1 flex-row">
      <View class={panelStateFor(currentPanelKey()).maximized ? "hidden" : "min-w-0 flex-1"}>
        {button("Fixture toggle panel", toggleRightPanelAction)}
        {button("Fixture toggle drawer", toggleTerminalAction)}
        {button("Fixture toggle maximized", toggleMaximizedAction)}
        <Text>{`webviews:${JSON.stringify(webViewMounts())}`}</Text>
        <Text>{`panel-width:${width()}`}</Text>
        <Text>{`thread:${currentPanelKey()}`}</Text>
        <Text>{`overlay:${overlay()}`}</Text>
        {button("Show thread 1", () => overridePanelContext(threads.one))}
        {button("Show thread 2", () => overridePanelContext(threads.two))}
        {button("Web views under surface", () => overrideWebViewsUnderSurface(true))}
        {button("Web views above surface", () => overrideWebViewsUnderSurface(false))}
        {button("Open overlay", () => { release?.(); release = registerOverlay("fixture overlay"); overlay.set(true); })}
        {button("Close overlay", () => { release?.(); release = null; overlay.set(false); })}
        {button("Open settings", () => openSettings())}
        {button("Close settings", () => closeSettings())}
        {button("Go to page b", () => setPreviewUrlAction("browser:1", "http://127.0.0.1:9/b"))}
        {button("Fixture split panel terminal", () => { const tab = panelStateFor(currentPanelKey()).surfaces.find((surface) => surface.kind === "terminal"); if (tab) splitPanelTerminalAction(tab.id); })}
        {button("Commit drawer height", () => { const key = currentPanelKey(); if (key) updateDrawer(key, (current) => ({ ...current, height: current.height + 10 })); })}
        <View class="flex-1" />
        {panelStateFor(currentPanelKey()).terminalOpen ? <TerminalDrawer stateKey={currentPanelKey() ?? ""} threadId="thread-1" cwd="/project" request={rpc} windowHeight={() => windowSize().height} /> : null}
      </View>
      <RightPanel onWidth={(value) => width.set(value)} request={rpc} windowWidth={() => windowSize().width} rowWidth={() => windowSize().width} />
    </View>
  </View>
));
