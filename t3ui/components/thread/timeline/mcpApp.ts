// MCP Apps in the timeline: shared/mcpApp.ts readMcpAppReference + toolOutput.ts mcpAppFromToolItem, and the
// client-runtime mcpApps/host.ts JSON-RPC host the app's page talks to. Pure (no store, no views) so it is testable.
import { readResult } from "./htmlRenderReference";

export const MCP_APP_PROTOCOL_VERSION = "2026-01-26";
export const MCP_APP_OUTPUT_KEY = "t3McpApp";
export const MCP_APP_RESOURCE_SCHEME = "ui://";
export const MCP_APP_DEFAULT_HEIGHT = 320;
export const MCP_APP_MAX_HEIGHT = 2000;
const MAX_NAME_LENGTH = 256;
const MAX_RESOURCE_URI_LENGTH = 2048;
const MAX_PENDING_REQUESTS = 16;

export interface McpAppReference { attachmentId: string; server: string; tool: string; resourceUri: string; prefersBorder?: boolean }

const boundedName = (value: unknown) => (typeof value === "string" && value.trim() !== "" && value.length <= MAX_NAME_LENGTH ? value : undefined);

export function readMcpAppReference(value: unknown): McpAppReference | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const attachmentId = boundedName(record.attachmentId);
  const server = boundedName(record.server);
  const tool = boundedName(record.tool);
  const resourceUri = typeof record.resourceUri === "string" && record.resourceUri.length <= MAX_RESOURCE_URI_LENGTH ? record.resourceUri : undefined;
  if (!attachmentId || !server || !tool || !resourceUri || !resourceUri.startsWith(MCP_APP_RESOURCE_SCHEME)) return undefined;
  return { attachmentId, server, tool, resourceUri, ...(typeof record.prefersBorder === "boolean" ? { prefersBorder: record.prefersBorder } : {}) };
}

const claudeMcpToolNamePart = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_");
export function claudeMcpToolName(server: string, tool: string): string {
  const part = claudeMcpToolNamePart(server);
  const prefix = `mcp__${server.startsWith("claude.ai ") ? part.replace(/_+/g, "_").replace(/^_|_$/g, "") : part}__`;
  return `${prefix}${claudeMcpToolNamePart(tool)}`;
}

/** mcpAppFromToolItem: a dynamic tool call whose output names an app of the tool that produced it. */
export function mcpAppFromToolItem(item: { toolName?: unknown; output?: unknown; type?: unknown }): McpAppReference | undefined {
  if (item.type !== "dynamic_tool") return undefined;
  const result = readResult(item.output);
  if (result.failed) return undefined;
  const app = readMcpAppReference(result.data?.[MCP_APP_OUTPUT_KEY]);
  return app && (item.toolName === `${app.server}.${app.tool}` || item.toolName === claudeMcpToolName(app.server, app.tool)) ? app : undefined;
}

export interface McpAppCallToolResult { content: unknown[]; structuredContent?: unknown; isError?: boolean; _meta?: unknown }
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** normalizeMcpAppToolResult: providers report absent fields as null, which the MCP Apps SDK rejects. */
export function normalizeMcpAppToolResult(result: unknown): McpAppCallToolResult {
  const record = isObject(result) ? result : {};
  return {
    content: Array.isArray(record.content) ? record.content : [],
    ...(isObject(record.structuredContent) ? { structuredContent: record.structuredContent } : {}),
    ...(record.isError === true ? { isError: true } : {}),
    ...(isObject(record._meta) ? { _meta: record._meta } : {}),
  };
}

export class McpAppHostRefusal extends Error {}

export type McpAppDisplayMode = "inline" | "fullscreen";
export interface McpAppHostContext { theme: "light" | "dark"; displayMode: McpAppDisplayMode; availableDisplayModes: McpAppDisplayMode[]; containerDimensions: { width: number; maxHeight: number } | { width: number; height: number }; platform: "desktop"; locale: string; timeZone: string; userAgent: string; toolInfo?: { tool: unknown } }

export interface McpAppHostOptions {
  post: (message: unknown) => void;
  hostVersion: string;
  hostContext: () => McpAppHostContext;
  callTool: (input: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
  readResource: (input: { uri: string }) => Promise<unknown>;
  openLink: (url: string) => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  updateModelContext: (input: { content?: unknown[]; structuredContent?: Record<string, unknown> }) => Promise<void>;
  onSizeChanged: (size: { width?: number; height?: number }) => void;
  onRequestTeardown: () => void;
  /** host.ts requestDisplayMode: switches (or refuses) and resolves with the mode now in effect. */
  requestDisplayMode?: (mode: McpAppDisplayMode) => Promise<McpAppDisplayMode>;
}

type Id = string | number;
const isId = (value: unknown): value is Id => typeof value === "string" || (typeof value === "number" && Number.isFinite(value));

/** makeMcpAppHost, without file downloads (full screen when the frame offers `requestDisplayMode`). */
export function makeMcpAppHost(options: McpAppHostOptions) {
  let initialized = false;
  let disposed = false;
  let pending = 0;
  let toolCall: { arguments: unknown; result: McpAppCallToolResult | undefined } | undefined;
  let toolCallSent = false;
  let sentContext: McpAppHostContext | undefined;
  let appDisplayModes: string[] | undefined;
  const post = (message: unknown) => { if (!disposed) options.post(message); };
  const notify = (method: string, params: unknown) => post({ jsonrpc: "2.0", method, params });
  const respond = (id: Id, result: unknown) => post({ jsonrpc: "2.0", id, result });
  const fail = (id: Id, code: number, message: string) => post({ jsonrpc: "2.0", id, error: { code, message } });
  const errorMessage = (error: unknown) => (error instanceof Error && error.message.trim() !== "" ? error.message : "Request failed.");
  const sendToolCall = () => {
    if (!initialized || toolCall === undefined || toolCallSent) return;
    toolCallSent = true;
    notify("ui/notifications/tool-input", { arguments: isObject(toolCall.arguments) ? toolCall.arguments : {} });
    if (toolCall.result !== undefined) notify("ui/notifications/tool-result", toolCall.result);
  };
  const answer = (id: Id, run: () => Promise<unknown>) => {
    if (pending >= MAX_PENDING_REQUESTS) { fail(id, -32000, "Too many requests in flight."); return; }
    pending += 1;
    void run().then((result) => { pending -= 1; respond(id, result); }, (error: unknown) => { pending -= 1; fail(id, -32000, errorMessage(error)); });
  };
  const request = (id: Id, method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "ui/initialize": {
        const declared = isObject(params.appCapabilities) ? params.appCapabilities.availableDisplayModes : undefined;
        appDisplayModes = Array.isArray(declared) ? declared.filter((mode): mode is string => typeof mode === "string") : undefined;
        sentContext = options.hostContext();
        respond(id, {
          protocolVersion: params.protocolVersion === MCP_APP_PROTOCOL_VERSION ? params.protocolVersion : MCP_APP_PROTOCOL_VERSION,
          hostInfo: { name: "t3-code", version: options.hostVersion },
          hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {}, logging: {}, message: { text: {} }, updateModelContext: { text: {}, structuredContent: {} }, sandbox: {} },
          hostContext: sentContext,
        });
        return;
      }
      case "ping": respond(id, {}); return;
      case "tools/call": {
        const name = params.name;
        const args = params.arguments ?? {};
        if (typeof name !== "string" || name.trim() === "" || !isObject(args)) { fail(id, -32602, "tools/call needs a tool name and object arguments."); return; }
        answer(id, () => options.callTool({ name, arguments: args }).then(normalizeMcpAppToolResult));
        return;
      }
      case "resources/read": {
        const uri = params.uri;
        if (typeof uri !== "string" || uri.trim() === "") { fail(id, -32602, "resources/read needs a uri."); return; }
        answer(id, () => options.readResource({ uri }));
        return;
      }
      case "ui/open-link": {
        const url = params.url;
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) { fail(id, -32602, "Only http(s) links can be opened."); return; }
        answer(id, () => options.openLink(url).then(() => ({})));
        return;
      }
      case "ui/message": {
        const blocks = Array.isArray(params.content) ? params.content : [params.content];
        const texts = blocks.map((block) => (isObject(block) && block.type === "text" && typeof block.text === "string" ? block.text : undefined));
        if (params.role !== "user" || texts.length === 0 || texts.includes(undefined)) { fail(id, -32602, "Only text messages from the user role are supported."); return; }
        const text = texts.join("\n").trim();
        if (text === "") { fail(id, -32602, "ui/message needs non-empty text."); return; }
        answer(id, () => options.sendMessage(text).then(() => ({})));
        return;
      }
      case "ui/request-display-mode": {
        // A mode the host lacks, or the app did not declare, leaves the current one.
        const current = options.hostContext().displayMode;
        const mode = params.mode;
        const allowed = typeof mode === "string" && (options.hostContext().availableDisplayModes as string[]).includes(mode) && (appDisplayModes === undefined || appDisplayModes.includes(mode));
        if (!allowed || mode === current || !options.requestDisplayMode) { respond(id, { mode: current }); return; }
        answer(id, () => options.requestDisplayMode!(mode as McpAppDisplayMode).then((result) => ({ mode: result })));
        return;
      }
      case "ui/update-model-context": {
        const content = params.content;
        const structured = params.structuredContent;
        if ((content !== undefined && !Array.isArray(content)) || (structured !== undefined && !isObject(structured))) { fail(id, -32602, "Model context needs content blocks or an object of structured content."); return; }
        answer(id, () => options.updateModelContext({ ...(content === undefined ? {} : { content: content as unknown[] }), ...(structured === undefined ? {} : { structuredContent: structured as Record<string, unknown> }) }).then(() => ({})));
        return;
      }
      default: fail(id, -32601, `Method not found: ${method}`);
    }
  };
  const notification = (method: string, params: Record<string, unknown>) => {
    if (method === "ui/notifications/initialized") { if (initialized) return; initialized = true; sendToolCall(); host.updateHostContext(); }
    else if (method === "ui/notifications/size-changed") {
      const width = typeof params.width === "number" ? params.width : undefined;
      const height = typeof params.height === "number" ? params.height : undefined;
      if (width !== undefined || height !== undefined) options.onSizeChanged({ ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }) });
    } else if (method === "ui/notifications/request-teardown") options.onRequestTeardown();
  };
  const host = {
    receive(data: unknown) {
      if (disposed || !isObject(data) || data.jsonrpc !== "2.0") return;
      const method = data.method;
      if (typeof method !== "string") return;
      const params = isObject(data.params) ? data.params : {};
      if (isId(data.id)) request(data.id, method, params); else notification(method, params);
    },
    setToolCall(call: { arguments: unknown; result: McpAppCallToolResult | undefined }) {
      if (toolCall === undefined || !toolCallSent) { if (toolCall?.result === undefined) toolCall = call; sendToolCall(); return; }
      if (toolCall.result !== undefined || call.result === undefined) return;
      toolCall = { arguments: toolCall.arguments, result: call.result };
      notify("ui/notifications/tool-result", call.result);
    },
    updateHostContext() {
      if (!initialized || sentContext === undefined) return;
      const next = options.hostContext();
      const changes: Record<string, unknown> = {};
      for (const key of Object.keys(next) as (keyof McpAppHostContext)[]) if (JSON.stringify(next[key]) !== JSON.stringify(sentContext[key])) changes[key] = next[key];
      sentContext = next;
      if (Object.keys(changes).length > 0) notify("ui/notifications/host-context-changed", changes);
    },
    dispose() { disposed = true; },
  };
  return host;
}

export function clampMcpAppHeight(height: number): number {
  return Math.min(MCP_APP_MAX_HEIGHT, Math.max(80, Math.ceil(height)));
}

/** Gives the page a `window.parent` whose postMessage reaches the native host (the page is top-level in a WebView, not a
 * frame), and lets the host deliver messages as `message` events from that parent. Runs before the page's own scripts. */
export const MCP_APP_BRIDGE_SCRIPT = `(function(){var p={postMessage:function(m){try{window.nsh.postMessage(JSON.stringify(m));}catch(e){}}};try{Object.defineProperty(window,"parent",{configurable:true,get:function(){return p;}});}catch(e){window.parent=p;}window.__t3McpDeliver=function(m){var e=new MessageEvent("message",{data:m,origin:"null"});try{Object.defineProperty(e,"source",{value:p});}catch(x){}window.dispatchEvent(e);};})();true;`;

/** The injected call that delivers one host message to the page. */
export const mcpAppDeliverScript = (message: unknown) => `window.__t3McpDeliver&&window.__t3McpDeliver(${JSON.stringify(message)});true;`;
