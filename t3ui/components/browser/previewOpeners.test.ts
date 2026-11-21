import { expect, test } from "nsh/test";
import { overridePanelContext, panelStateFor } from "../rightPanel/panelState";
import { overridePreviewScope } from "../rightPanel/previewScope";
import { allowsPreviewTunnel, canOpenFileInPreview, isBrowserPreviewFile, openDiscoveredServer, openFileInPreview, openUrlInPreviewTab, previewAssetResource, previewTunnelUrl, resolveDiscoveredServerUrl, resolveExternalServerTarget } from "./previewOpeners";

const panelKey = "opener-thread";
const withThread = () => overridePanelContext({ key: panelKey, workspace: { threadId: "thread-1", cwd: "/work/app" } });
const done = () => { overridePanelContext(null); overridePreviewScope(null); };

test("HTML and PDF files are the ones the preview browser offers to open", () => {
  expect(isBrowserPreviewFile("docs/index.html")).toBe(true);
  expect(isBrowserPreviewFile("a/b.HTM?x=1")).toBe(true);
  expect(isBrowserPreviewFile("a/b.pdf#page=2")).toBe(true);
  expect(isBrowserPreviewFile("a/b.ts")).toBe(false);
});

test("a file inside the project is a workspace file, any other a media file", () => {
  expect(previewAssetResource("t1", "/work/app/docs/a.html", "/work/app")).toEqual({ _tag: "workspace-file", threadId: "t1", path: "/work/app/docs/a.html" });
  expect(previewAssetResource("t1", "/tmp/a.html", "/work/app")).toEqual({ _tag: "media-file", threadId: "t1", path: "/tmp/a.html" });
  expect(previewAssetResource("t1", "/work/app-two/a.html", "/work/app").path).toBe("/work/app-two/a.html");
  expect(previewAssetResource("t1", "/work/app-two/a.html", "/work/app")._tag).toBe("media-file");
});

test("Open file in preview browser asks the environment for a signed URL and opens it in a tab", async () => {
  withThread();
  overridePreviewScope("granted");
  const calls: string[] = [];
  const url = await openFileInPreview(
    { threadId: "thread-1", filePath: "/work/app/docs/a.html", workspaceRoot: "/work/app" },
    { request: async (method, payload) => { calls.push(`${method}:${JSON.stringify(payload)}`); return { relativeUrl: "/api/assets/abc/a.html" }; }, endpoint: "ws://127.0.0.1:3773/ws", open: (opened) => calls.push(`open:${opened}`) },
  );
  expect(url).toBe("http://127.0.0.1:3773/api/assets/abc/a.html");
  expect(calls).toEqual(['assets.createUrl:{"resource":{"_tag":"workspace-file","threadId":"thread-1","path":"/work/app/docs/a.html"}}', "open:http://127.0.0.1:3773/api/assets/abc/a.html"]);
  done();
});

test("an invalid asset URL and a missing scope are refused with a reason", async () => {
  withThread();
  overridePreviewScope("granted");
  let message = "";
  try { await openFileInPreview({ threadId: "t", filePath: "/work/app/a.html", workspaceRoot: "/work/app" }, { request: async () => ({ relativeUrl: "https://evil.example/x" }), endpoint: "ws://127.0.0.1:3773/ws" }); } catch (cause) { message = (cause as Error).message; }
  expect(message).toBe("The environment returned an invalid asset URL.");
  overridePreviewScope("denied");
  try { await openFileInPreview({ threadId: "t", filePath: "/work/app/a.html", workspaceRoot: "/work/app" }, { request: async () => ({ relativeUrl: "/api/assets/x" }) }); message = ""; } catch (cause) { message = (cause as Error).message; }
  expect(message).toBe("Preview access is unavailable for this client.");
  expect(canOpenFileInPreview("a.html")).toBe(false);
  overridePreviewScope("granted");
  expect(canOpenFileInPreview("a.html")).toBe(true);
  expect(canOpenFileInPreview("a.ts")).toBe(false);
  done();
});

test("a page and a discovered server open as new browser tabs, remembered in the panel", () => {
  withThread();
  overridePreviewScope("granted");
  openUrlInPreviewTab("https://example.com/");
  openDiscoveredServer("http://localhost:5173/", "ws://127.0.0.1:3773/ws");
  const tabs = panelStateFor(panelKey).surfaces.filter((surface) => surface.kind === "preview");
  expect(tabs.map((tab) => tab.previewUrl)).toEqual(["https://example.com/", "http://localhost:5173/"]);
  done();
});

test("without the scope nothing opens", () => {
  withThread();
  overridePreviewScope("denied");
  let refused = false;
  try { openUrlInPreviewTab("https://example.com/"); } catch { refused = true; }
  expect(refused).toBe(true);
  done();
});

test("a loopback server of another machine on the private network opens at that machine's address", () => {
  expect(resolveDiscoveredServerUrl("ws://127.0.0.1:3773/ws", "http://localhost:3000/a?b=1")).toBe("http://localhost:3000/a?b=1");
  expect(resolveDiscoveredServerUrl("wss://192.168.1.20:3773/ws", "http://localhost:3000/a?b=1")).toBe("http://192.168.1.20:3000/a?b=1");
  expect(resolveDiscoveredServerUrl("wss://env.example.com/ws", "http://localhost:3000/")).toBe("http://localhost:3000/");
  expect(resolveDiscoveredServerUrl("wss://192.168.1.20/ws", "https://example.com/x")).toBe("https://example.com/x");
});

test("fm13: a discovered loopback server is rewritten to a remote private-network environment's host, as browserTargetResolver does", () => {
  // The app's own (loopback) server: the loopback address stays, normalized.
  expect(resolveDiscoveredServerUrl("ws://127.0.0.1:3773/ws", "localhost:5173/app")).toBe("http://localhost:5173/app");
  // A LAN / Tailscale / .local / IPv6 ULA environment: its host, keeping port, path, search and hash.
  expect(resolveDiscoveredServerUrl("wss://10.0.0.4:3773/ws", "http://127.0.0.1:8080/x?y=1#z")).toBe("http://10.0.0.4:8080/x?y=1#z");
  expect(resolveDiscoveredServerUrl("wss://box.tail1234.ts.net/ws", "http://0.0.0.0:3000/")).toBe("http://box.tail1234.ts.net:3000/");
  expect(resolveDiscoveredServerUrl("wss://studio.local:3773/ws", "http://[::1]:4000/")).toBe("http://studio.local:4000/");
  expect(resolveDiscoveredServerUrl("wss://[fd12::5]:3773/ws", "http://localhost:4000/")).toBe("http://[fd12::5]:4000/");
  // A public environment address: no direct route, the address is opened as given.
  expect(resolveDiscoveredServerUrl("wss://8.8.8.8/ws", "http://localhost:4000/")).toBe("http://localhost:4000/");
  // A non-loopback page is only normalized.
  expect(resolveDiscoveredServerUrl("wss://10.0.0.4/ws", "example.com/a")).toBe("https://example.com/a");
});

test("preview tunnel helpers evaluate settings/policy and build websocket tunnel urls", () => {
  expect(allowsPreviewTunnel(null)).toBe(false);
  expect(allowsPreviewTunnel({ settings: { enablePreviewTunnel: true } })).toBe(true);
  expect(allowsPreviewTunnel({ settings: { enablePreviewTunnel: false } })).toBe(false);
  expect(allowsPreviewTunnel({ settings: { enablePreviewTunnel: true }, managedPolicy: { limits: { previewTunnel: false } } })).toBe(false);

  expect(previewTunnelUrl("https://host.example:3773/ws", "ticket-123")).toBe("wss://host.example:3773/api/preview/tunnel?wsTicket=ticket-123");
  expect(previewTunnelUrl("http://127.0.0.1:3773/ws")).toBe("ws://127.0.0.1:3773/api/preview/tunnel");

  expect(resolveExternalServerTarget("ws://127.0.0.1:3773/ws", "http://localhost:3000/")).toEqual({ url: "http://localhost:3000/", remoteLoopbackUnavailable: false });
  expect(resolveExternalServerTarget("wss://8.8.8.8:3773/ws", "http://localhost:3000/")).toEqual({ url: "http://localhost:3000/", remoteLoopbackUnavailable: true });
});
