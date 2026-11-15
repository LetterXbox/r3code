// The right panel over two made-up threads with the floating browser preview: a count of how often each native web
// view was made (webViewMounts.ts), the floating state of the open thread as a text line, and buttons for what a test
// cannot reach through the panel itself (switching threads, choosing the host kind).
import { mount, Text, View, windowSize } from "nsh";
import { RightPanel } from "./RightPanel";
import { overrideWebViewsUnderSurface } from "./nativeOcclusion";
import { miniPlayerFor, openDeviceMiniPlayer, reportChatCanvas } from "./miniPlayerState";
import { deviceSurfaceId } from "./panelLogic";

const DEVICE = { hostId: "local", deviceId: "sim-1", platform: "ios" as const, name: "iPhone 17" };
import { closeActiveSurfaceAction, closeRightPanelAction, currentPanelKey, overridePanelContext, panelStateFor, toggleRightPanelAction } from "./panelState";
import { togglePreview } from "../../commands/standardCommands";
import { overridePreviewScope } from "./previewScope";
import { webViewMounts } from "./webViewMounts";

overridePreviewScope("granted");
const threads = {
  one: { key: "mini-thread-1", workspace: { threadId: "thread-1", cwd: "/project" } },
  two: { key: "mini-thread-2", workspace: { threadId: "thread-2", cwd: "/project" } },
};
overridePanelContext(threads.one);
overrideWebViewsUnderSurface(true);
// The chat canvas ThreadView reports: under a 52pt header, 700 x 700.
reportChatCanvas({ origin: { y: 52 }, size: { width: 700, height: 700 } });

async function rpc(): Promise<unknown> { return undefined; }
const button = (label: string, onPress: () => void) => <View accessibilityLabel={label} role="button" onPress={onPress}><Text>{label}</Text></View>;

mount(() => (
  <View class="flex-1 bg-background">
    <View class="relative min-h-0 flex-1 flex-row">
      <View class="min-w-0 flex-1">
        {button("Fixture toggle panel", toggleRightPanelAction)}
        {button("Fixture close panel", closeRightPanelAction)}
        {button("Fixture toggle preview", () => { togglePreview(); })}
        {button("Fixture close active tab", closeActiveSurfaceAction)}
        {button("Show thread 1", () => overridePanelContext(threads.one))}
        {button("Show thread 2", () => overridePanelContext(threads.two))}
        {button("Web views under surface", () => overrideWebViewsUnderSurface(true))}
        {button("Web views above surface", () => overrideWebViewsUnderSurface(false))}
        {button("Float a device", () => { const k = currentPanelKey(); if (k) openDeviceMiniPlayer(k, deviceSurfaceId(DEVICE), DEVICE); })}
        {button("Narrow canvas", () => reportChatCanvas({ origin: { y: 52 }, size: { width: 300, height: 400 } }))}
        <Text>{`webviews:${JSON.stringify(webViewMounts())}`}</Text>
        <Text>{`mini:${JSON.stringify(miniPlayerFor(currentPanelKey()))}`}</Text>
        <Text>{`panel:${JSON.stringify({ open: panelStateFor(currentPanelKey()).open, active: panelStateFor(currentPanelKey()).activeId })}`}</Text>
        <Text>{`thread:${currentPanelKey()}`}</Text>
      </View>
      <RightPanel request={rpc} windowWidth={() => windowSize().width} rowWidth={() => windowSize().width} />
    </View>
  </View>
));
