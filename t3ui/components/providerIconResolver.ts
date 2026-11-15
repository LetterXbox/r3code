// providerInstances.ts deriveProviderInstanceEntries + applyProviderInstanceBranding: the artwork an acpRegistry instance
// shows. The snapshot's iconUrl first; settings providerInstances[id].config registryIconUrl overrides it, and a local
// (source "local") agent drops the registry branding. Every ProviderIconView given an instanceId reads it here.
import { rawProviderRecords } from "../store";
import { serverSettings } from "../pages/settings/settingsState";

const rec = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

export interface AcpRegistryBranding { agentId?: string; iconUrl?: string }

export function resolveAcpRegistryBranding(instanceId: string, providers: readonly Record<string, unknown>[], settings: unknown): AcpRegistryBranding {
  const snapshot = providers.find((provider) => provider.instanceId === instanceId);
  if (!snapshot || snapshot.driver !== "acpRegistry") return {};
  const base: AcpRegistryBranding = text(snapshot.iconUrl) ? { iconUrl: text(snapshot.iconUrl) } : {};
  const instances = rec(rec(settings)?.providerInstances);
  const explicit = instances && Object.hasOwn(instances, instanceId) ? rec(instances[instanceId]) : null;
  if (!explicit) return base;
  const config = rec(explicit.config);
  if (config?.source === "local") return {};
  return {
    ...base,
    ...(text(config?.agentId) ? { agentId: text(config?.agentId) } : {}),
    ...(text(config?.registryIconUrl) ? { iconUrl: text(config?.registryIconUrl) } : {}),
  };
}

const ACP_REGISTRY_CDN_HOSTNAME = "cdn.agentclientprotocol.com";
const ACP_REGISTRY_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** contracts acpRegistry.ts officialAcpRegistryIconUrlForAgentId: the registry CDN's artwork for an agent id. */
export function officialAcpRegistryIconUrlForAgentId(agentId: string | null | undefined): string | null {
  if (agentId === null || agentId === undefined || !ACP_REGISTRY_AGENT_ID_PATTERN.test(agentId)) return null;
  return `https://${ACP_REGISTRY_CDN_HOSTNAME}/registry/v1/latest/${agentId}.svg`;
}

/** contracts acpRegistry.ts resolveOfficialAcpRegistryIconUrl: only https URLs on the registry CDN (no port or credentials). */
export function resolveOfficialAcpRegistryIconUrl(icon: string | null | undefined): string | null {
  if (!icon) return null;
  try {
    const url = new URL(icon);
    if (url.protocol !== "https:" || url.hostname !== ACP_REGISTRY_CDN_HOSTNAME || url.port !== "" || url.username !== "" || url.password !== "") return null;
    return url.href;
  } catch {
    return null;
  }
}

/** ProviderInstanceIcon resolveProviderInstanceAcpRegistryIconUrl: the official icon URL, else the agent id's CDN artwork. */
export function resolveAcpRegistryIconUrl(branding: AcpRegistryBranding): string | null {
  return resolveOfficialAcpRegistryIconUrl(branding.iconUrl ?? null) ?? officialAcpRegistryIconUrlForAgentId(branding.agentId?.trim() || null);
}

/** The live icon URL for an instance, null when it has no (official) registry artwork. */
export function acpRegistryIconUrl(instanceId: string | null | undefined): string | null {
  if (!instanceId) return null;
  return resolveAcpRegistryIconUrl(resolveAcpRegistryBranding(instanceId, rawProviderRecords() as Record<string, unknown>[], serverSettings()));
}
