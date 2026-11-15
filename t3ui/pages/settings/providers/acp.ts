// AcpRegistrySearchStep.tsx and AddProviderInstanceDialog.logic.ts: the ACP Registry half of the
// add-provider wizard (search, prepare, then Identity and Sign in).
import { rec } from "./logic";
import { resolveWizardNavigation, type WizardNavigation } from "./logic";

export const ACP_REGISTRY_WIZARD_STEPS = ["Provider", "Identity", "Sign in"] as const;
export const LOCAL_ACP_WIZARD_STEPS = ["Provider", "Identity"] as const;
export const ACP_REGISTRY_MAX_AGENTS = 50;
export const ACP_REGISTRY_SEARCH_DEBOUNCE_MS = 300;

/** Registry agents the built-in providers already cover, so searching does not list them twice. */
export const FIRST_CLASS_REGISTRY_AGENT_IDS = new Set(["codex-acp", "claude-acp", "antigravity-acp", "grok-build", "cursor", "opencode", "opencode-v2", "pi-acp"]);

export interface AcpAgent {
  id: string; name: string; version: string; description: string; website: string | null; repository: string | null; icon: string | null;
  distribution: "binary" | "npx" | "uvx";
}

export function readAcpAgents(value: unknown): AcpAgent[] {
  const agents = rec(value)?.agents;
  if (!Array.isArray(agents)) return [];
  return agents.flatMap((raw) => {
    const item = rec(raw);
    if (!item || typeof item.id !== "string" || typeof item.name !== "string") return [];
    const distribution = item.distribution === "binary" || item.distribution === "uvx" ? item.distribution : "npx";
    const text = (key: string) => typeof item[key] === "string" && item[key] ? item[key] as string : null;
    return [{ id: item.id, name: item.name, version: text("version") ?? "", description: text("description") ?? "", website: text("website"), repository: text("repository"), icon: text("icon"), distribution }];
  });
}

/** An agent a prepare call confirmed: the id, version and distribution the server settled on. */
export function applyPrepareResult(agent: AcpAgent, prepared: unknown): AcpAgent {
  const result = rec(prepared);
  if (!result || typeof result.agentId !== "string") return agent;
  return { ...agent, id: result.agentId, version: typeof result.version === "string" ? result.version : agent.version,
    distribution: result.distribution === "binary" || result.distribution === "uvx" || result.distribution === "npx" ? result.distribution : agent.distribution };
}

export function isConfiguredAcpRegistryAgent(instances: Readonly<Record<string, { driver: string; config?: unknown }>>, agentId: string): boolean {
  return Object.values(instances).some((instance) => {
    if (instance.driver !== "acpRegistry" || !instance.config || typeof instance.config !== "object") return false;
    const config = instance.config as Record<string, unknown>;
    return config.source !== "local" && config.agentId === agentId;
  });
}

/** Only the official CDN's icons are loaded, as resolveOfficialAcpRegistryIconUrl. */
export function officialAcpIconUrl(icon: string | null | undefined): string | null {
  if (!icon) return null;
  try {
    const url = new URL(icon);
    return url.protocol === "https:" && url.hostname === "cdn.agentclientprotocol.com" && url.port === "" && url.username === "" && url.password === "" ? url.href : null;
  } catch { return null; }
}

export function resolveAcpNavigation(current: number, requested: number, validation: { instanceIdError: string | null; selectionError: string | null; local: boolean }): WizardNavigation {
  const steps = validation.local ? LOCAL_ACP_WIZARD_STEPS : ACP_REGISTRY_WIZARD_STEPS;
  const target = Math.max(0, Math.min(steps.length - 1, requested));
  if (validation.selectionError && current <= 0 && target > 0) return { kind: "blocked", step: 0, error: validation.selectionError };
  return resolveWizardNavigation(current, requested, steps.length, { instanceIdError: validation.instanceIdError, identityStep: 1 });
}
