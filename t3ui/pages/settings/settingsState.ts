// What the server has said about its own settings and keybindings.
//
// This module imports nothing from store.ts: store.ts calls
// observeServerConfigEvent from handleConfigEvent, so a back-import would be
// a cycle. The config stream (`subscribeServerConfig`) carries settings in its
// `snapshot` and `settingsUpdated` events and the resolved keybindings in its
// `snapshot` and `keybindingsUpdated` events (packages/contracts server.ts).
import { signal } from "nsh";
import { observeEnvironmentThemesEvent, setEnvironmentThemes } from "./environmentThemes";

type Dict = Record<string, unknown>;

const server = signal<Dict | null>(null);
const keybindings = signal<Dict[]>([]);
const environment = signal<Dict | null>(null);
const managedPolicy = signal<Dict | null>(null);
const observability = signal<Dict | null>(null);

/** The server's ServerSettings, or null until the first config snapshot. */
export const serverSettings = () => server();
/** The resolved keybindings the server reports (`ResolvedKeybindingsConfig`). */
export const serverKeybindings = () => keybindings();
/** The ExecutionEnvironmentDescriptor of the connected server, if any. */
export const serverEnvironment = () => environment();
/** The administrator's ManagedPolicySummary from the config snapshot, or null when the environment is unmanaged. */
export const serverManagedPolicy = () => managedPolicy();
/** The `observability` the server is running with (`ServerConfig.observability`: effective endpoints and what set them). */
export const serverObservability = () => observability();

function dict(value: unknown): Dict | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dict) : null;
}

export function replaceServerSettings(next: unknown) {
  const value = dict(next);
  if (value) server.set(value);
}

export function replaceServerKeybindings(next: unknown) {
  if (Array.isArray(next)) keybindings.set(next.filter(dict) as Dict[]);
}

export function resetServerConfig() {
  server.set(null);
  keybindings.set([]);
  environment.set(null);
  managedPolicy.set(null);
  observability.set(null);
  setEnvironmentThemes([]);
}

/** Feed every `subscribeServerConfig` event through here. */
export function observeServerConfigEvent(event: unknown) {
  const e = dict(event);
  if (!e) return;
  // The snapshot's `environmentThemes` and `environmentThemesUpdated` (useEnvironmentTheme.ts).
  observeEnvironmentThemesEvent(e);
  if (e.type === "snapshot") {
    const config = dict(e.config);
    if (!config) return;
    replaceServerSettings(config.settings);
    if (Array.isArray(config.keybindings)) keybindings.set(config.keybindings.filter(dict) as Dict[]);
    const env = dict(config.environment);
    if (env) environment.set(env);
    managedPolicy.set(dict(config.managedPolicy));
    observability.set(dict(config.observability));
    return;
  }
  const payload = dict(e.payload);
  if (!payload) return;
  if (e.type === "settingsUpdated") replaceServerSettings(payload.settings);
  else if (e.type === "keybindingsUpdated" && Array.isArray(payload.keybindings)) {
    keybindings.set(payload.keybindings.filter(dict) as Dict[]);
  }
}
