import { expect, test } from "nsh/test";
import { applyConfigEvent, liveProviderApi, resetLiveProviderState, savedDeviceDetail } from "./data";

const provider = (instanceId: string, extra: Record<string, unknown> = {}) => ({ instanceId, driver: instanceId, enabled: true, installed: true, version: "1.0.0", status: "ready", auth: { status: "authenticated" }, models: [{ slug: "m", name: "M", isCustom: false, capabilities: null }], ...extra });

test("the config snapshot fills providers, instances, model preferences and favourites", () => {
  resetLiveProviderState();
  expect(liveProviderApi.loaded()).toBe(false);
  applyConfigEvent({ type: "snapshot", config: { providers: [provider("codex")], settings: {
    providerInstances: { codex: { driver: "codex", displayName: "Work" }, bad: { nope: true } },
    providerModelPreferences: { codex: { hiddenModels: ["m"], modelOrder: ["m", 3] } },
    favorites: [{ provider: "codex", model: "m" }, { provider: 1 }],
  } } });
  expect(liveProviderApi.loaded()).toBe(true);
  expect(liveProviderApi.providers().map((item) => item.instanceId)).toEqual(["codex"]);
  expect(liveProviderApi.providers()[0].models[0].slug).toBe("m");
  expect(Object.keys(liveProviderApi.instances())).toEqual(["codex"]);
  expect(liveProviderApi.modelPrefs()).toEqual({ codex: { hiddenModels: ["m"], modelOrder: ["m"] } });
  expect(liveProviderApi.favorites()).toEqual([{ provider: "codex", model: "m" }]);
});

test("status pushes replace providers without touching settings, and settings pushes the reverse", () => {
  resetLiveProviderState();
  applyConfigEvent({ type: "snapshot", config: { providers: [provider("codex")], settings: { providerInstances: { codex: { driver: "codex" } } } } });
  applyConfigEvent({ type: "providerStatuses", payload: { providers: [provider("codex", { version: "2.0.0" }), provider("grok")] } });
  expect(liveProviderApi.providers().map((item) => item.version)).toEqual(["2.0.0", "1.0.0"]);
  expect(Object.keys(liveProviderApi.instances())).toEqual(["codex"]);
  applyConfigEvent({ type: "settingsUpdated", payload: { settings: { providerInstances: { codex: { driver: "codex" }, grok: { driver: "grok", enabled: true } } } } });
  expect(Object.keys(liveProviderApi.instances())).toEqual(["codex", "grok"]);
  expect(liveProviderApi.providers().length).toBe(2);
  applyConfigEvent({ type: "keybindingsUpdated", payload: { keybindings: [] } });
  expect(liveProviderApi.providers().length).toBe(2);
});

test("a malformed provider is skipped and nothing is claimed live without a connection", () => {
  resetLiveProviderState();
  applyConfigEvent({ type: "snapshot", config: { providers: [provider("codex"), { driver: "x" }, 5], settings: { providerInstances: {} } } });
  expect(liveProviderApi.providers().length).toBe(1);
  expect(liveProviderApi.status()).toBe("disconnected");
  expect(liveProviderApi.live()).toBe(false);
});

test("the config snapshot carries the managed policy and a reset drops it", () => {
  resetLiveProviderState();
  expect(liveProviderApi.managedPolicy()).toBeUndefined();
  applyConfigEvent({ type: "snapshot", config: { providers: [], settings: { providerInstances: {} }, managedPolicy: { organization: "Acme", lockedSettings: [], limits: { providers: { allowedDrivers: ["codex"] } } } } });
  expect(liveProviderApi.managedPolicy()?.organization).toBe("Acme");
  applyConfigEvent({ type: "providerStatuses", payload: { providers: [] } });
  expect(liveProviderApi.managedPolicy()?.organization).toBe("Acme");
  resetLiveProviderState();
  expect(liveProviderApi.managedPolicy()).toBeUndefined();
});

test("a saved device on this machine reads Local device, others their address", () => {
  expect(savedDeviceDetail("ws://127.0.0.1:3773/ws")).toBe("Local device");
  expect(savedDeviceDetail("ws://localhost:3773/ws")).toBe("Local device");
  expect(savedDeviceDetail("wss://build.example/ws")).toBe("wss://build.example/ws");
  expect(savedDeviceDetail(undefined)).toBe("Remote device");
});
