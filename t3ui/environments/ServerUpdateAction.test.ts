import { expect, test } from "nsh/test";
import { performServerUpdate } from "./ServerUpdateAction";
import { RequestFailure } from "../backend/client";
import { canMaintain, manualServerUpdateCommand, planServerUpdate, runServerUpdate, serverUpdateFailed, setMaintainGrantForTest, updateCapabilities } from "./ServerUpdateAction";
import { environmentMcpUrl } from "../pages/settings/environments/savedEnvironments";

test("planServerUpdate follows ServerUpdateAction: note, copy relaunch/update command, or Update", () => {
  const base = { serverLabel: "box", targetVersion: "1.2.0", installation: undefined, desktopAppUpdate: false };
  expect(planServerUpdate({ ...base, selfUpdate: "desktop-managed" })).toEqual({ kind: "note", text: "Update the desktop app on that machine to update this server." });
  const copy = planServerUpdate({ ...base, selfUpdate: null });
  expect(copy.kind === "copy" && copy.label).toBe("Copy relaunch command");
  expect(copy.kind === "copy" && copy.title).toBe("Relaunch command copied");
  expect(copy.kind === "copy" && copy.command).toBe("npx t3@1.2.0");
  const npm = planServerUpdate({ ...base, selfUpdate: null, installation: { kind: "npm-global", prefix: "/opt/it's" } });
  expect(npm.kind === "copy" && npm.label).toBe("Copy update command");
  expect(manualServerUpdateCommand("1.2.0", { kind: "npm-global", prefix: "/opt/it's" })).toBe("npm install --global --prefix '/opt/it'\\''s' t3@1.2.0");
  const desktop = planServerUpdate({ ...base, selfUpdate: "desktop-managed", desktopAppUpdate: true });
  expect(desktop.kind === "update" && desktop.confirm).toBe("Update the R3 Code desktop app that runs the box? It will close and relaunch on that machine.");
  expect(planServerUpdate({ ...base, selfUpdate: "respawn" })).toEqual({ kind: "update", label: "Update", confirm: null });
  expect(updateCapabilities({ environment: { capabilities: { serverSelfUpdate: "respawn", serverInstallation: { kind: "bunx" } } } })).toEqual({ selfUpdate: "respawn", installation: { kind: "bunx" }, desktopAppUpdate: false, progress: false });
});

test("the Update action needs the session's environment:maintain grant", () => {
  setMaintainGrantForTest((key) => key === "ok");
  expect(canMaintain("ok", "ws://x/ws", async () => "t")).toBe(true);
  expect(canMaintain("no", "ws://x/ws", async () => "t")).toBe(false);
  setMaintainGrantForTest(null);
});

test("a failed update turns the button into Retry update until one succeeds", async () => {
  const input = { key: "retry-env", serverLabel: "box server", selfUpdate: "respawn" as const, targetVersion: "1.2.0" };
  expect(serverUpdateFailed("retry-env")).toBe(false);
  await runServerUpdate({ ...input, request: async () => { throw new Error("boom"); } });
  expect(serverUpdateFailed("retry-env")).toBe(true);
  await runServerUpdate({ ...input, request: async () => ({ targetVersion: "1.2.0" }) });
  expect(serverUpdateFailed("retry-env")).toBe(false);
});

test("Copy MCP URL copies the environment's address at /mcp", () => {
  expect(environmentMcpUrl("wss://box.example.ts.net/ws?x=1#y")).toBe("https://box.example.ts.net/mcp");
  expect(environmentMcpUrl("http://127.0.0.1:3773")).toBe("http://127.0.0.1:3773/mcp");
  expect(environmentMcpUrl("not a url")).toBe(null);
});

test("runServerUpdate drives the composer notice state and Retry re-runs the failed update", async () => {
  const { serverUpdateState } = await import("../components/banners/serverUpdate");
  const input = { key: "notice-env", serverLabel: "box server", selfUpdate: "respawn" as const, targetVersion: "1.3.0" };
  let release: () => void = () => {};
  const running = runServerUpdate({ ...input, request: () => new Promise((resolve) => { release = () => resolve({ targetVersion: "1.3.0" }); }) });
  expect(serverUpdateState().status).toBe("running");
  release();
  await running;
  expect(serverUpdateState().status).toBe("idle");
  await runServerUpdate({ ...input, request: async () => { throw new Error("disk full"); } });
  const failed = serverUpdateState();
  expect(failed.status === "failed" && failed.message).toBe("disk full");
  const { canRetryServerUpdate } = await import("./ServerUpdateAction");
  expect(canRetryServerUpdate()).toBe(true);
});

// ---- server.updateServerWithProgress / server.commitDesktopUpdate (client-runtime server.ts updateServer) ----

type Feed = (onValue: (value: unknown) => void, onError: (error: Error) => void) => void;
const progressServer = (feed: Feed) => {
  const calls: { method: string; payload: unknown }[] = [];
  const request = async (method: string, payload: unknown) => { calls.push({ method, payload }); return {}; };
  const subscribe = (method: string, payload: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void) => { calls.push({ method, payload }); queueMicrotask(() => feed(onValue, onError)); return () => {}; };
  return { calls, request, subscribe };
};

test("a server with progress runs updateServerWithProgress and reports its stages", async () => {
  const s = progressServer((onValue, onError) => {
    onValue({ type: "progress", stage: "downloading" });
    onValue({ type: "progress", stage: "installing" });
    onValue({ type: "complete", result: { targetVersion: "1.2.0", method: "respawn" } });
    onError(new Error("Environment subscription ended unexpectedly"));
  });
  const stages: string[] = [];
  const result = await performServerUpdate({ key: "k", serverLabel: "S", selfUpdate: "respawn", targetVersion: "1.2.0", request: s.request, subscribe: s.subscribe, progress: true }, (stage) => stages.push(stage));
  expect(result).toEqual({ targetVersion: "1.2.0", method: "respawn" });
  expect(s.calls).toEqual([{ method: "server.updateServerWithProgress", payload: { targetVersion: "1.2.0" } }]);
  expect(stages).toEqual(["downloading", "installing", "resuming", "resuming"]);
});

test("a desktop-app result with a token is committed; a dropped socket on commit is success", async () => {
  const s = progressServer((onValue, onError) => {
    onValue({ type: "complete", result: { targetVersion: "1.2.0", method: "desktop-app", desktopUpdateToken: "tok" } });
    onError(new Error("Environment subscription ended unexpectedly"));
  });
  const request = async (method: string, payload: unknown) => { s.calls.push({ method, payload }); throw new Error("Environment disconnected"); };
  const result = await performServerUpdate({ key: "k", serverLabel: "S", selfUpdate: "desktop-managed", targetVersion: "1.2.0", request, subscribe: s.subscribe, progress: true }, () => {});
  expect(result.method).toBe("desktop-app");
  expect(s.calls[1]).toEqual({ method: "server.commitDesktopUpdate", payload: { requestId: "tok" } });
});

test("progress then a dropped socket on a respawn server is an accepted restart; a server failure rejects; no terminal rejects", async () => {
  const lost = progressServer((onValue, onError) => { onValue({ type: "progress", stage: "installing" }); onError(new Error("The environment closed the connection")); });
  expect((await performServerUpdate({ key: "k", serverLabel: "S", selfUpdate: "respawn", targetVersion: "2.0.0", request: lost.request, subscribe: lost.subscribe, progress: true }, () => {})).method).toBe("respawn");
  const failed = progressServer((_onValue, onError) => onError(new RequestFailure("Server update failed: disk full", "ServerSelfUpdateError", "disk full")));
  let message = "";
  await performServerUpdate({ key: "k", serverLabel: "S", selfUpdate: "respawn", targetVersion: "2.0.0", request: failed.request, subscribe: failed.subscribe, progress: true }, () => {}).catch((error: Error) => { message = error.message; });
  expect(message).toBe("Server update failed: disk full");
  const empty = progressServer((_onValue, onError) => onError(new Error("Environment subscription ended unexpectedly")));
  await performServerUpdate({ key: "k", serverLabel: "S", selfUpdate: "respawn", targetVersion: "2.0.0", request: empty.request, subscribe: empty.subscribe, progress: true }, () => {}).catch((error: Error) => { message = error.message; });
  expect(message).toBe("The t3@2.0.0 update ended before the server accepted the restart.");
});

test("a client-side refusal on a respawn server is a failure, not an accepted restart", async () => {
  let message = "";
  await performServerUpdate({ key: "k", serverLabel: "S", selfUpdate: "respawn", targetVersion: "2.0.0", request: async () => { throw new Error("Connect an environment first"); } }, () => {}).catch((error: Error) => { message = error.message; });
  expect(message).toBe("Connect an environment first");
  const accepted = await performServerUpdate({ key: "k", serverLabel: "S", selfUpdate: "respawn", targetVersion: "2.0.0", request: async () => { throw new Error("The environment closed the connection"); } }, () => {});
  expect(accepted).toEqual({ targetVersion: "2.0.0", method: "respawn" });
});
