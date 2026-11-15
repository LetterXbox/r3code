// state/peerLinks.ts useLinkedEnvironments + linkRequest.ts linkedEnvironmentNames: the machines an environment links
// to (peerLinks.list), named as this client names them, else as the link does; expired links are left out. Asked only
// while the environment offers links, and shared for a short while.
import { signal } from "nsh";
import { record } from "../backend/client";
import { connectedMachines } from "./machines";
import { offersLinkedEnvironments, mentionableMachines } from "./machineMentions";

export function linkedEnvironmentNames(input: { links: readonly { environmentId: string; label: string; status?: string }[]; environments: readonly { environmentId: string; label: string }[] }): Map<string, string> {
  const names = new Map(input.environments.map((environment) => [environment.environmentId, environment.label]));
  return new Map(input.links.flatMap((link) => link.status === "expired" ? [] : [[link.environmentId, names.get(link.environmentId) ?? link.label] as const]));
}

const LINKS_FRESH_MS = 30_000;
const links = signal<Record<string, { at: number; links: { environmentId: string; label: string; status?: string }[] }>>({});
const inFlight = new Set<string>();

function readLinks(value: unknown): { environmentId: string; label: string; status?: string }[] {
  const list = record(value)?.links;
  return Array.isArray(list) ? list.flatMap((item) => {
    const link = record(item);
    return typeof link?.environmentId === "string" ? [{ environmentId: link.environmentId, label: typeof link.label === "string" ? link.label : link.environmentId, ...(typeof link.status === "string" ? { status: link.status } : {}) }] : [];
  }) : [];
}

/** The linked machines of a machine ("primary" or a saved environment id) by name; empty unless it offers links. */
export function linkedEnvironments(machineKey: string, config: { environment?: unknown; settings?: unknown } | null, primaryConfig: { environment?: unknown } | null): Map<string, string> {
  if (!offersLinkedEnvironments(config)) return new Map();
  const cached = links()[machineKey];
  if ((!cached || Date.now() - cached.at > LINKS_FRESH_MS) && !inFlight.has(machineKey)) {
    const machine = connectedMachines().find((item) => item.key === machineKey);
    if (machine) {
      inFlight.add(machineKey);
      void machine.request("peerLinks.list", {}).then((value) => links.update((all) => ({ ...all, [machineKey]: { at: Date.now(), links: readLinks(value) } })))
        .catch(() => links.update((all) => ({ ...all, [machineKey]: { at: Date.now(), links: [] } })))
        .finally(() => inFlight.delete(machineKey));
    }
  }
  return linkedEnvironmentNames({ links: cached?.links ?? [], environments: mentionableMachines(primaryConfig) });
}
