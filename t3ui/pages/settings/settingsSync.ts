// Reads and writes settings the way the web's useSettings hook does
// (hooks/useSettings.ts): a key of ServerSettings goes to
// `server.updateSettings` as `{ patch: { key: value } }`, every other key is
// a client setting kept on this device. The server replies with the full
// ServerSettings, which replaces our copy.
//
// A server write is optimistic: the new value shows at once, and if the
// request fails the value reverts and `settingsWriteError` carries the
// message for the panel to show.
import { syncSharedSettings } from "../../environments/sharedSettings";
import { signal } from "nsh";
import { backendStatus, requestBackend, settingValue, subscribeBackend, updateSetting } from "../../store";
import { defaultOfSetting, hasSetting, scopeOfSetting } from "./settingsDefaults";
import { replaceServerSettings, serverSettings } from "./settingsState";
import { record } from "../../backend/client";
import { environmentConfigs, environmentConnections, requestEnvironment } from "../../environments/connectionManager";

export type SettingScope = "client" | "server" | null | undefined;

interface SyncDeps {
  request: (method: string, payload: unknown) => Promise<unknown>;
  connected: () => boolean;
  subscribe: (method: string, payload: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void) => () => void;
}

let deps: SyncDeps = {
  request: (method, payload) => requestBackend(method, payload),
  subscribe: (method, payload, onValue, onError) => subscribeBackend(method, payload, onValue, onError),
  connected: () => backendStatus() === "connected",
};

// The settings scope bar can select a connected saved environment: its settings are then read from and written to
// that environment's own session (environments/connectionManager.ts), not the primary's.
let target: () => string | null = () => null;
/** scopeState.ts names the saved environment the scope selects, or null for the primary. */
export function configureSettingsTarget(next: () => string | null) { target = next; }
function connectedNow(): boolean {
  const id = target();
  return id ? environmentConnections()[id]?.phase === "connected" : deps.connected();
}
function requestNow(method: string, payload: unknown): Promise<unknown> {
  const id = target();
  return id ? requestEnvironment(id, method, payload) : deps.request(method, payload);
}
/** The selected environment's ServerSettings. */
export function currentServerSettings(): Record<string, unknown> | null {
  const id = target();
  return id ? record(environmentConfigs()[id]?.settings) : serverSettings();
}
/** Takes a server.updateSettings answer for the selected environment. */
export function acceptServerSettings(next: unknown) {
  const id = target();
  const value = record(next);
  if (!id) { replaceServerSettings(next); return; }
  if (value) environmentConfigs.update((all) => ({ ...all, [id]: { ...(all[id] ?? {}), settings: value } }));
}

/** Tests swap the transport; the app never calls this. */
export function configureSettingsSync(next: Partial<SyncDeps>) {
  deps = { ...deps, ...next };
}

const pendingValues = signal<Record<string, unknown>>({});
const writeError = signal("");
const versions = new Map<string, number>();

/** The last failed write's message, empty when the last write succeeded. */
export const settingsWriteError = () => writeError();
export function clearSettingsWriteError() {
  writeError.set("");
}

/** The field's own scope when the panels know it, else the caller's. */
function resolvedScope(field: string, scope: SettingScope): SettingScope {
  return hasSetting(field) ? scopeOfSetting(field) : scope;
}

/** Current value: a pending optimistic write, else the server, else the seeded default. */
export function readSetting(field: string, scope: SettingScope): unknown {
  // The field's own scope decides (the web's SERVER_SETTINGS_KEYS), not the caller's: a server
  // setting is never read from the local blob and a client one is never read from the server.
  scope = resolvedScope(field, scope);
  if (scope === "server") {
    const pending = pendingValues();
    if (field in pending) return pending[field];
    const reported = connectedNow() ? currentServerSettings() : null;
    if (reported && field in reported && reported[field] !== undefined) return reported[field];
    // Not reported yet: the default, never a value from the local blob.
    return defaultOfSetting(field);
  }
  return settingValue(field);
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Writes one setting. Resolves when the server (or local store) has taken it. */
export async function writeSetting(field: string, scope: SettingScope, value: string | boolean | number | null): Promise<void> {
  scope = resolvedScope(field, scope);
  if (scope !== "server") {
    writeError.set("");
    if (value !== null) updateSetting(field, value);
    return;
  }
  if (!connectedNow()) {
    writeError.set("Connect an environment to change this setting.");
    return;
  }
  writeError.set("");
  const version = (versions.get(field) ?? 0) + 1;
  versions.set(field, version);
  pendingValues.update((all) => ({ ...all, [field]: value }));
  try {
    const source = currentServerSettings();
    acceptServerSettings(await requestNow("server.updateSettings", { patch: { [field]: value } }));
    // useSettings.ts: a shared setting also goes to every other connected environment.
    void syncSharedSettings({ [field]: value }, source);
  } catch (cause) {
    writeError.set(message(cause));
  } finally {
    if (versions.get(field) === version) {
      pendingValues.update((all) => {
        const { [field]: _dropped, ...rest } = all;
        return rest;
      });
    }
  }
}

/** A server call for panels that write something other than a setting (keybindings). */
export function requestServer(method: string, payload: unknown): Promise<unknown> {
  if (!connectedNow()) return Promise.reject(new Error("Connect an environment to change this setting."));
  return requestNow(method, payload);
}

export const isServerConnected = () => connectedNow();

/** A server stream for settings panels (server.getStorageCleanupReport, server.getDatabaseStorage); tests swap it. */
export function subscribeServer(method: string, payload: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void): () => void {
  return deps.subscribe(method, payload, onValue, onError);
}
