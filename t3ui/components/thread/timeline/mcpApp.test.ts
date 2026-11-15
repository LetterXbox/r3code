import { expect, test } from "nsh/test";
import { claudeMcpToolName, makeMcpAppHost, mcpAppFromToolItem } from "./mcpApp";

const app = { attachmentId: "att-1", server: "weather", tool: "forecast", resourceUri: "ui://weather/app.html" };

test("an MCP app is read from the tool output of the tool that made it (mcpAppFromToolItem)", () => {
  const output = { structuredContent: { t3McpApp: app } };
  expect(mcpAppFromToolItem({ type: "dynamic_tool", toolName: "weather.forecast", output })?.attachmentId).toBe("att-1");
  expect(mcpAppFromToolItem({ type: "dynamic_tool", toolName: claudeMcpToolName("weather", "forecast"), output })?.server).toBe("weather");
  expect(mcpAppFromToolItem({ type: "dynamic_tool", toolName: "other.tool", output })).toBe(undefined);
  expect(mcpAppFromToolItem({ type: "dynamic_tool", toolName: "weather.forecast", output: { isError: true, structuredContent: { t3McpApp: app } } })).toBe(undefined);
});

test("the host answers initialize, sends the tool call after initialized, and routes tools/call", async () => {
  const posted: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const host = makeMcpAppHost({
    post: (message) => posted.push(message as Record<string, unknown>), hostVersion: "1",
    hostContext: () => ({ theme: "dark", displayMode: "inline", availableDisplayModes: ["inline"], containerDimensions: { width: 700, maxHeight: 2000 }, platform: "desktop", locale: "en", timeZone: "UTC", userAgent: "t3-code/1" }),
    callTool: async ({ name }) => { calls.push(name); return { content: [{ type: "text", text: "ok" }], _meta: null }; },
    readResource: async () => ({ contents: [] }), openLink: async () => {}, sendMessage: async () => {}, updateModelContext: async () => {},
    onSizeChanged: () => {}, onRequestTeardown: () => {},
  });
  host.setToolCall({ arguments: { city: "Leeds" }, result: { content: [] } });
  host.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { protocolVersion: "2026-01-26" } });
  expect((posted[0]!.result as { protocolVersion: string }).protocolVersion).toBe("2026-01-26");
  host.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  expect(posted.map((message) => message.method).filter(Boolean)).toEqual(["ui/notifications/tool-input", "ui/notifications/tool-result"]);
  host.receive({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "refresh", arguments: {} } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toEqual(["refresh"]);
  expect(posted.at(-1)).toEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ok" }] } });
  host.receive({ jsonrpc: "2.0", id: 3, method: "nope" });
  expect((posted.at(-1)!.error as { code: number }).code).toBe(-32601);
});

test("the tool definition mcpApps.toolInfo returns joins the host context and is pushed once it arrives", () => {
  const posted: Record<string, unknown>[] = [];
  let tool: unknown = undefined;
  const host = makeMcpAppHost({
    post: (message) => posted.push(message as Record<string, unknown>), hostVersion: "1",
    hostContext: () => ({ theme: "dark", displayMode: "inline", availableDisplayModes: ["inline"], containerDimensions: { width: 700, maxHeight: 2000 }, platform: "desktop", locale: "en", timeZone: "UTC", userAgent: "t3-code/1", ...(tool === undefined ? {} : { toolInfo: { tool } }) }),
    callTool: async () => ({}), readResource: async () => ({ contents: [] }), openLink: async () => {}, sendMessage: async () => {}, updateModelContext: async () => {},
    onSizeChanged: () => {}, onRequestTeardown: () => {},
  });
  host.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
  host.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  tool = { name: "forecast", inputSchema: { type: "object" } };
  host.updateHostContext();
  expect(posted.at(-1)).toEqual({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { toolInfo: { tool: { name: "forecast", inputSchema: { type: "object" } } } } });
});

test("ui/request-display-mode switches to full screen only for a mode both sides declare (host.ts)", async () => {
  const posted: Record<string, unknown>[] = [];
  let mode: "inline" | "fullscreen" = "inline";
  const make = () => makeMcpAppHost({
    post: (message) => posted.push(message as Record<string, unknown>), hostVersion: "1",
    hostContext: () => ({ theme: "dark", displayMode: mode, availableDisplayModes: ["inline", "fullscreen"], containerDimensions: mode === "fullscreen" ? { width: 900, height: 600 } : { width: 700, maxHeight: 2000 }, platform: "desktop", locale: "en", timeZone: "UTC", userAgent: "t3-code/1" }),
    callTool: async () => ({}), readResource: async () => ({ contents: [] }), openLink: async () => {}, sendMessage: async () => {}, updateModelContext: async () => {},
    onSizeChanged: () => {}, onRequestTeardown: () => {},
    requestDisplayMode: async (next) => { mode = next; return next; },
  });
  const host = make();
  host.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] } } });
  host.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  host.receive({ jsonrpc: "2.0", id: 2, method: "ui/request-display-mode", params: { mode: "pip" } });
  host.receive({ jsonrpc: "2.0", id: 3, method: "ui/request-display-mode", params: { mode: "fullscreen" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  host.updateHostContext();
  expect(posted.find((message) => message.id === 2)?.result).toEqual({ mode: "inline" });
  expect(posted.find((message) => message.id === 3)?.result).toEqual({ mode: "fullscreen" });
  expect(posted.find((message) => message.method === "ui/notifications/host-context-changed")?.params).toEqual({ displayMode: "fullscreen", containerDimensions: { width: 900, height: 600 } });
  // An app that declared inline only keeps inline.
  mode = "inline";
  const declined = make();
  posted.length = 0;
  declined.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { appCapabilities: { availableDisplayModes: ["inline"] } } });
  declined.receive({ jsonrpc: "2.0", id: 2, method: "ui/request-display-mode", params: { mode: "fullscreen" } });
  expect(posted.find((message) => message.id === 2)?.result).toEqual({ mode: "inline" });
});
