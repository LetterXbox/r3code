import { expect, test } from "nsh/test";
import { clearSettingsWriteError, configureSettingsSync, readSetting, settingsWriteError, writeSetting } from "./pages/settings/settingsSync";
import { observeServerConfigEvent, resetServerConfig, serverKeybindings, serverSettings } from "./pages/settings/settingsState";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("config snapshots and settingsUpdated events populate server settings and keybindings", () => {
  resetServerConfig();
  expect(serverSettings()).toBe(null);
  observeServerConfigEvent({ type: "snapshot", config: { settings: { responseStreamingMode: "turn" }, keybindings: [{ command: "chat.new" }] } });
  expect(serverSettings()?.responseStreamingMode).toBe("turn");
  expect(serverKeybindings().length).toBe(1);
  observeServerConfigEvent({ type: "settingsUpdated", payload: { settings: { responseStreamingMode: "paragraph" } } });
  expect(serverSettings()?.responseStreamingMode).toBe("paragraph");
  observeServerConfigEvent({ type: "keybindingsUpdated", payload: { keybindings: [] } });
  expect(serverKeybindings().length).toBe(0);
});

test("a server write shows at once, patches the server, and takes the reply", async () => {
  resetServerConfig();
  observeServerConfigEvent({ type: "snapshot", config: { settings: { responseStreamingMode: "paragraph" } } });
  const calls: unknown[] = [];
  const reply = deferred<unknown>();
  configureSettingsSync({ connected: () => true, request: (method, payload) => { calls.push([method, payload]); return reply.promise; } });
  const done = writeSetting("responseStreamingMode", "server", "turn");
  expect(readSetting("responseStreamingMode", "server")).toBe("turn");
  expect(calls).toEqual([["server.updateSettings", { patch: { responseStreamingMode: "turn" } }]]);
  reply.resolve({ responseStreamingMode: "turn" });
  await done;
  expect(readSetting("responseStreamingMode", "server")).toBe("turn");
  expect(settingsWriteError()).toBe("");
});

test("a failed server write reverts and reports the error", async () => {
  resetServerConfig();
  observeServerConfigEvent({ type: "snapshot", config: { settings: { responseStreamingMode: "paragraph" } } });
  configureSettingsSync({ connected: () => true, request: () => Promise.reject(new Error("Settings are managed by policy")) });
  await writeSetting("responseStreamingMode", "server", "turn");
  expect(readSetting("responseStreamingMode", "server")).toBe("paragraph");
  expect(settingsWriteError()).toBe("Settings are managed by policy");
  clearSettingsWriteError();
  expect(settingsWriteError()).toBe("");
});

test("a server write while disconnected does not change the value and says why", async () => {
  resetServerConfig();
  let called = false;
  configureSettingsSync({ connected: () => false, request: () => { called = true; return Promise.resolve({}); } });
  const before = readSetting("responseStreamingMode", "server");
  await writeSetting("responseStreamingMode", "server", "turn");
  expect(called).toBe(false);
  expect(readSetting("responseStreamingMode", "server")).toBe(before);
  expect(settingsWriteError()).toBe("Connect an environment to change this setting.");
});

test("client settings are kept locally and never sent to the server", async () => {
  let called = false;
  configureSettingsSync({ connected: () => true, request: () => { called = true; return Promise.resolve({}); } });
  await writeSetting("chatWidth", "client", "wide");
  expect(called).toBe(false);
  expect(readSetting("chatWidth", "client")).toBe("wide");
});
