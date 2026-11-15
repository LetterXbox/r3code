// chat/McpAppFrame.tsx: an MCP app's page (its ui:// resource, stored as a thread attachment) in a WebView, talking to
// the host in mcpApp.ts over JSON-RPC. The page is top-level in the WebView, so MCP_APP_BRIDGE_SCRIPT gives it the
// `window.parent` an MCP Apps page posts to. Tool calls, resource reads and model context go to the server's mcpApps.*
// RPCs; tools that are not read-only and messages the app sends ask first. On a host that draws WebViews above the app
// the row is a card that opens the page full screen, as html-render rows do.
import { colorScheme, effect, openUrl, signal, Text, untracked, View, WebView } from "nsh";
import type { WebViewRef } from "nsh";
import { Dialog } from "nsh/base";
import { TimelineIcon } from "../markdown/TimelineIcon";
import { useOverlayOpen, webViewsUnderSurface } from "../../rightPanel/nativeOcclusion";
import { keepPressInDialog } from "../../dialogSurface";
import { EscapeCancel } from "../../EscapeCancel";
import { DIALOG_MS } from "../../motion/motionTokens";
import { confirm } from "../../toast";
import { assetUrlFor } from "../../sidebar/projectIcon";
import { backendUrl, requestBackend, sendDraft, withThreadScope } from "../../../store";
import { clampMcpAppHeight, makeMcpAppHost, MCP_APP_BRIDGE_SCRIPT, MCP_APP_DEFAULT_HEIGHT, MCP_APP_MAX_HEIGHT, mcpAppDeliverScript, McpAppHostRefusal, normalizeMcpAppToolResult, type McpAppDisplayMode, type McpAppReference } from "./mcpApp";
import { HTML_RENDER_WHEEL_SCRIPT, readTimelineWheel } from "./htmlRenderWheel";

/** McpAppFrame data-mcp-app-fullscreen: one app is full screen at a time (another app's request keeps its mode). */
const fullscreenOwner = signal<string | null>(null);

type Request = (method: string, payload: unknown) => Promise<unknown>;

const parseJson = (text: string): unknown => { try { return JSON.parse(text); } catch { return { content: [{ type: "text", text }] }; } };

export function mcpAppFileName(reference: McpAppReference): string {
  return `${reference.tool.replace(/[^\w.-]+/g, "-").slice(0, 80) || "app"}.html`;
}

async function mintMcpAppUrl(reference: McpAppReference, request: Request, endpoint: string): Promise<string> {
  const response = await request("assets.createUrl", {
    resource: { _tag: "attachment", attachmentId: reference.attachmentId, fileName: mcpAppFileName(reference), mimeType: "text/html", disposition: "inline" },
  }) as { relativeUrl?: unknown } | null;
  const src = assetUrlFor(endpoint, response?.relativeUrl);
  if (src === null) throw new Error("The environment returned an invalid asset URL.");
  return src;
}

function McpAppDocument(props: { src: string; app: McpAppReference; threadId: string; itemId: string; toolCall: () => { arguments: unknown; result: unknown }; request: Request; onHeight: (height: number) => void; width: () => number;
  displayMode: () => McpAppDisplayMode; fullscreenHeight: () => number; requestDisplayMode: (mode: McpAppDisplayMode) => McpAppDisplayMode; onTeardown: () => void; onTimelineWheel?: (delta: number) => void }) {
  let ref: WebViewRef | null = null;
  const target = { threadId: props.threadId, itemId: props.itemId };
  // The tool definition an app reads from its host context (mcpApps.toolInfo's `tool`; toolInfoQuery in the reference).
  const toolDefinition = signal<unknown>(undefined);
  const host = makeMcpAppHost({
    hostVersion: "t3-code",
    post: (message) => ref?.injectJavaScript(mcpAppDeliverScript(message)),
    hostContext: () => ({
      theme: colorScheme() === "dark" ? "dark" : "light", displayMode: props.displayMode(), availableDisplayModes: ["inline", "fullscreen"],
      containerDimensions: props.displayMode() === "fullscreen" ? { width: props.width(), height: props.fullscreenHeight() } : { width: props.width(), maxHeight: MCP_APP_MAX_HEIGHT }, platform: "desktop",
      locale: Intl.DateTimeFormat().resolvedOptions().locale, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, userAgent: "t3-code",
      ...(toolDefinition() === undefined ? {} : { toolInfo: { tool: toolDefinition() } }),
    }),
    callTool: async ({ name, arguments: args }) => {
      const info = await props.request("mcpApps.toolInfo", { ...target, name }) as { callable?: boolean; readOnly?: boolean; title?: string } | null;
      if (!info?.callable) throw new McpAppHostRefusal("This app cannot call that tool.");
      if (!info.readOnly && !(await confirm(`Allow ${props.app.server} to run ${info.title ?? name}?\n${JSON.stringify(args, null, 2)}`))) throw new McpAppHostRefusal("Declined by the user.");
      return props.request("mcpApps.callTool", { ...target, name, arguments: args });
    },
    readResource: ({ uri }) => props.request("mcpApps.readResource", { ...target, uri }),
    openLink: async (url) => { openUrl(url); },
    sendMessage: async (text) => {
      if (!(await confirm(`Send this message from ${props.app.server}?\n${text}`))) throw new McpAppHostRefusal("Declined by the user.");
      withThreadScope(props.threadId, () => sendDraft({ text, intent: "auto" }));
    },
    updateModelContext: async (context) => { await props.request("mcpApps.updateModelContext", { ...target, conversationThreadId: props.threadId, ...context }); },
    // Ignore the full-screen height when restoring inline sizing.
    onSizeChanged: (size) => { if (size.height !== undefined && props.displayMode() !== "fullscreen") props.onHeight(clampMcpAppHeight(size.height)); },
    onRequestTeardown: () => props.onTeardown(),
    requestDisplayMode: async (mode) => props.requestDisplayMode(mode),
  });
  effect(() => { const call = props.toolCall(); untracked(() => host.setToolCall({ arguments: call.arguments, result: call.result === undefined ? undefined : normalizeMcpAppToolResult(typeof call.result === "string" ? parseJson(call.result) : call.result) })); });
  effect(() => { colorScheme(); props.width(); toolDefinition(); props.displayMode(); props.fullscreenHeight(); untracked(() => host.updateHostContext()); });
  // A failed read leaves the context without a tool definition, as the reference's query does.
  void props.request("mcpApps.toolInfo", { ...target, name: props.app.tool }).then((info) => {
    const tool = (info as { tool?: unknown } | null)?.tool;
    if (tool !== undefined) toolDefinition.set(tool);
  }, () => undefined);
  effect(() => () => host.dispose());
  return (
    <WebView
      ref={(node) => { ref = node; }}
      src={props.src}
      class="size-full bg-background"
      accessibilityLabel={`${props.app.server} app`}
      injectedJavaScriptBeforeContentLoaded={MCP_APP_BRIDGE_SCRIPT}
      injectedJavaScript={props.onTimelineWheel ? HTML_RENDER_WHEEL_SCRIPT : undefined}
      onMessage={(event) => { const delta = readTimelineWheel(event.data); if (delta !== undefined) { props.onTimelineWheel?.(delta); return; } try { host.receive(JSON.parse(event.data)); } catch { /* Not a JSON-RPC message. */ } }}
    />
  );
}

export function McpAppFrame(props: { app: () => McpAppReference; threadId: () => string | null; itemId: () => string; toolCall: () => { arguments: unknown; result: unknown }; request?: Request; endpoint?: string; inline?: () => boolean; onTimelineWheel?: (delta: number) => void }) {
  const request = props.request ?? requestBackend;
  const src = signal<string | null>(null);
  const failed = signal(false);
  const height = signal(MCP_APP_DEFAULT_HEIGHT);
  const width = signal(700);
  const expanded = signal(false);
  const closed = signal(false);
  const generation = signal(0);
  const fullscreenHeight = signal(600);
  const ownerKey = `${Math.random()}`;
  const inline = () => (props.inline ? props.inline() : webViewsUnderSurface());
  const displayMode = (): McpAppDisplayMode => (expanded() ? "fullscreen" : "inline");
  const setExpanded = (next: boolean) => {
    expanded.set(next);
    if (next) fullscreenOwner.set(ownerKey);
    else if (untracked(fullscreenOwner) === ownerKey) fullscreenOwner.set(null);
  };
  effect(() => () => { if (untracked(fullscreenOwner) === ownerKey) fullscreenOwner.set(null); });
  // requestDisplayMode: full screen only while no other app holds it.
  const requestDisplayMode = (mode: McpAppDisplayMode): McpAppDisplayMode => {
    if (mode === "fullscreen" && untracked(fullscreenOwner) !== null && untracked(fullscreenOwner) !== ownerKey) return displayMode();
    setExpanded(mode === "fullscreen");
    return mode;
  };
  // onRequestTeardown: full screen goes back inline; inline, the app closes until "Show app".
  const teardown = () => { if (untracked(expanded)) { setExpanded(false); return; } closed.set(true); };
  const attachmentId = () => props.app().attachmentId;
  effect(() => {
    attachmentId();
    generation();
    src.set(null);
    failed.set(false);
    let stale = false;
    void mintMcpAppUrl(untracked(props.app), request, props.endpoint ?? backendUrl()).then((value) => { if (!stale) src.set(value); }, () => { if (!stale) failed.set(true); });
    return () => { stale = true; };
  });
  useOverlayOpen(() => expanded(), "mcp app", DIALOG_MS);
  const docProps = { displayMode, fullscreenHeight, requestDisplayMode, onTeardown: teardown };
  const label = () => `${props.app().server} app`;
  const document = () => (src() !== null && props.threadId() ? <McpAppDocument src={src()!} app={props.app()} threadId={props.threadId()!} itemId={props.itemId()} toolCall={props.toolCall} request={request} onHeight={(next) => height.set(next)} width={width} onTimelineWheel={expanded() ? undefined : props.onTimelineWheel} {...docProps} /> : null);
  const unable = () => `Unable to load the ${props.app().server} app`;
  return (
    <View class="min-w-0 px-1">
      {closed() ? (
        <View class="flex-row items-center justify-between gap-2 rounded-lg border border-border px-3 py-2" accessibilityLabel={label()}>
          <Text class="text-xs text-muted-foreground">{`The ${props.app().server} app was closed`}</Text>
          <View class="h-6 items-center justify-center rounded-md px-2 hover:bg-accent" role="button" accessibilityLabel="Show app" onPress={() => { closed.set(false); generation.update((value) => value + 1); }}>
            <Text class="text-xs text-foreground">Show app</Text>
          </View>
        </View>
      ) : inline() ? (
        <View class={`relative overflow-hidden ${props.app().prefersBorder === false ? "" : "rounded-lg border border-border"}`} style={{ height: height() }} onLayout={(event) => width.set(Math.max(1, Math.round(event.bounds.size.width)))} accessibilityLabel={label()}>
          {failed() ? <View class="size-full items-center justify-center"><Text class="text-xs text-muted-foreground">{unable()}</Text></View> : expanded() ? null : document()}
        </View>
      ) : (
        <View class="min-h-16 flex-row items-center gap-2 rounded-lg border border-border bg-card px-3 py-3" accessibilityLabel={label()}>
          <TimelineIcon name="package" size={14} />
          <Text class="min-w-0 flex-1 truncate text-sm text-foreground">{failed() ? unable() : label()}</Text>
          {src() !== null ? (
            <View class="size-6 items-center justify-center rounded-md hover:bg-accent" role="button" accessibilityLabel="Open full screen" tooltip="Open full screen" onPress={() => setExpanded(true)}>
              <TimelineIcon name="maximize-2" size={14} />
            </View>
          ) : null}
        </View>
      )}
      {!closed() ? (
        <Dialog open={expanded()} animation="fade" onOpenChange={({ open }) => { if (!open) setExpanded(false); }} backdropStyle={{ backgroundColor: "rgba(0,0,0,0.8)" }} style={{ margin: "auto", width: "92%", height: "92%" }}>
          {expanded() ? <EscapeCancel onCancel={() => setExpanded(false)} /> : null}
          {expanded() ? (
            <View class="size-full" onPress={keepPressInDialog} accessibilityLabel={`Expanded ${label()}`}>
              <View class="h-10 flex-row items-center justify-between">
                <Text class="min-w-0 flex-1 truncate text-sm text-white">{props.app().server}</Text>
                <View class="h-7 flex-row items-center gap-1.5 rounded-md px-2 hover:bg-accent-50" role="button" accessibilityLabel="Exit full screen" onPress={() => setExpanded(false)}>
                  <TimelineIcon name="minimize-2" size={14} tint="#ffffff" />
                  <Text class="text-xs text-white">Exit full screen</Text>
                </View>
              </View>
              <View class="min-h-0 flex-1 overflow-hidden rounded-lg border border-border-70 bg-background" onLayout={(event) => { width.set(Math.max(1, Math.round(event.bounds.size.width))); fullscreenHeight.set(Math.max(1, Math.round(event.bounds.size.height))); }}>{document()}</View>
            </View>
          ) : null}
        </Dialog>
      ) : null}
    </View>
  );
}
