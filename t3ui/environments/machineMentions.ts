// useComposerMenuItems.ts `@` machine mentions: offered only when the thread's environment offers links
// (linkRequest.ts offersLinkedEnvironments: capabilities.peerLinks and the Linked environments beta setting),
// naming the user's other machines by their server environment id.
import { record } from "../backend/client";
import { environmentConfigs, managedEnvironmentIds, parseScopedKey, scopedKey } from "./connectionManager";
import { connectedMachines } from "./machines";

export function offersLinkedEnvironments(config: { environment?: unknown; settings?: unknown } | null | undefined): boolean {
  return record(record(config?.environment)?.capabilities)?.peerLinks === true && record(config?.settings)?.linkedEnvironmentsEnabled === true;
}

/** The server EnvironmentId of a machine key ("primary" or a saved environment id). */
export function serverEnvironmentIdOf(key: string, primaryConfig: { environment?: unknown } | null): string | null {
  const environment = key === "primary" ? record(primaryConfig?.environment) : record(environmentConfigs()[key]?.environment);
  return typeof environment?.environmentId === "string" ? environment.environmentId : null;
}

export function mentionableMachines(primaryConfig: { environment?: unknown } | null): { environmentId: string; label: string; machine: "laptop" | "server" }[] {
  return connectedMachines().flatMap((machine) => {
    const environmentId = serverEnvironmentIdOf(machine.key, primaryConfig);
    return environmentId ? [{ environmentId, label: machine.label, machine: machine.machine }] : [];
  });
}

/** A store thread with its machine: a saved environment's thread names that server's environment id and its own id. */
export function machineScopedThread<T extends { id: string; environmentId?: string }>(thread: T, primaryConfig: { environment?: unknown } | null): T & { machineEnvironmentId?: string; localId?: string } {
  if (!thread.environmentId) { const primary = serverEnvironmentIdOf("primary", primaryConfig); return primary ? { ...thread, machineEnvironmentId: primary } : thread; }
  const environmentId = serverEnvironmentIdOf(thread.environmentId, primaryConfig);
  const localId = parseScopedKey(thread.id)?.localId;
  return environmentId && localId ? { ...thread, machineEnvironmentId: environmentId, localId } : thread;
}

/** The store id of a thread named by machine: a saved environment's thread is scoped, the primary's is its own id. */
export function storeThreadKey(environmentId: string | undefined, threadId: string): string {
  if (!environmentId) return threadId;
  const saved = managedEnvironmentIds().find((key) => serverEnvironmentIdOf(key, null) === environmentId);
  return saved ? scopedKey(saved, threadId) : threadId;
}
