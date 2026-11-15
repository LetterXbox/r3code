// Every connected machine as one shape: the primary connection (store.ts) and each saved environment's live session
// (connectionManager.ts), with their own unscoped request/subscribe, label, settings and the scope of their ids.
import { backendStatus, backendUrl, requestBackend, subscribeBackend } from "../store";
import { serverEnvironment, serverSettings } from "../pages/settings/settingsState";
import { record } from "../backend/client";
import { machineKindForUrl } from "../components/thread/environmentOptions";
import { environmentConfigs, environmentConnections, managedEnvironment, managedEnvironmentIds, requestEnvironment, scopedKey, subscribeEnvironment } from "./connectionManager";
import type { Request, Subscribe } from "./addProjectToMachine";

export interface Machine {
  /** "primary" or the saved environment id. */
  key: string;
  label: string;
  machine: "laptop" | "server";
  request: Request;
  subscribe: Subscribe;
  settings: () => Record<string, unknown> | null;
  /** ExecutionEnvironmentCapabilities of its descriptor. */
  capabilities: () => Record<string, unknown> | null;
  /** The store id of a local id on this machine. */
  scope: (localId: string) => string;
}

export function primaryMachine(): Machine | null {
  if (backendStatus() !== "connected") return null;
  const label = serverEnvironment()?.label;
  return {
    key: "primary", label: typeof label === "string" && label ? label : "This machine", machine: machineKindForUrl(backendUrl()),
    request: (method, payload, options) => requestBackend(method, payload, options),
    subscribe: (method, payload, onValue, onError) => subscribeBackend(method, payload, onValue, onError),
    settings: () => serverSettings(), capabilities: () => record(serverEnvironment()?.capabilities), scope: (id) => id,
  };
}

export function savedMachine(id: string): Machine | null {
  const environment = managedEnvironment(id);
  if (!environment || environmentConnections()[id]?.phase !== "connected") return null;
  return {
    key: id, label: environment.label, machine: machineKindForUrl(environment.url),
    request: (method, payload, options) => requestEnvironment(id, method, payload, options),
    subscribe: (method, payload, onValue, onError) => subscribeEnvironment(id, method, payload, onValue, onError),
    settings: () => record(environmentConfigs()[id]?.settings), capabilities: () => record(record(environmentConfigs()[id]?.environment)?.capabilities), scope: (localId) => scopedKey(id, localId),
  };
}

export function connectedMachines(): Machine[] {
  const primary = primaryMachine();
  const saved = managedEnvironmentIds().map(savedMachine).filter((item): item is Machine => item !== null);
  return [...(primary ? [primary] : []), ...saved];
}

/** The machine a store project id belongs to. */
export function machineOfProject(project: { environmentId?: string }): Machine | null {
  return project.environmentId ? savedMachine(project.environmentId) : primaryMachine();
}
