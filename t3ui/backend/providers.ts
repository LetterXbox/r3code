import { record } from "./client";
import { isAbsolute } from "path";

const BUILTIN_PROVIDERS = new Set(["codex", "claudeAgent", "cursor", "grok", "antigravity", "opencode", "kiro", "pi", "fx", "muse"]);

/** Only well-understood built-in fields may cross from another local environment. */
export function importableProviderInstances(source: unknown): { instanceId: string; instance: Record<string, unknown> }[] {
  const settings = record(source);
  const instances = record(settings?.providerInstances);
  if (!instances) return [];
  const result: { instanceId: string; instance: Record<string, unknown> }[] = [];
  for (const [instanceId, value] of Object.entries(instances)) {
    const sourceInstance = record(value);
    if (!BUILTIN_PROVIDERS.has(instanceId) || sourceInstance?.driver !== instanceId) continue;
    const sourceConfig = record(sourceInstance.config);
    const instance: Record<string, unknown> = { driver: instanceId };
    const enabled = typeof sourceInstance.enabled === "boolean" ? sourceInstance.enabled : sourceConfig?.enabled;
    if (typeof enabled === "boolean") instance.enabled = enabled;
    const config: Record<string, unknown> = {};
    const binaryPath = sourceConfig?.binaryPath;
    if (typeof binaryPath === "string" && binaryPath.length <= 4096 && !/[\u0000-\u001f\u007f?#]/.test(binaryPath) &&
        (isAbsolute(binaryPath) || /^[a-zA-Z0-9._+-]+$/.test(binaryPath))) config.binaryPath = binaryPath;
    if (Array.isArray(sourceConfig?.customModels)) {
      const models = sourceConfig.customModels.filter((model): model is string =>
        typeof model === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:+/-]{0,199}$/.test(model) && !model.includes("://"));
      if (models.length) config.customModels = models.slice(0, 100);
    }
    if (Object.keys(config).length) instance.config = config;
    if (Object.keys(instance).length > 1) result.push({ instanceId, instance });
  }
  return result;
}

/** Preserve the full server-provided instance, including redaction markers. */
export function providerToggleMutation(configValue: unknown, instanceId: string, enabled: boolean) {
  const config = record(configValue);
  const settings = record(config?.settings);
  const instances = record(settings?.providerInstances);
  if (!instances || !Array.isArray(config?.providers)) throw new Error("Provider settings are unavailable");
  const provider = config.providers.map(record).find((item) => item?.instanceId === instanceId);
  if (!provider || typeof provider.driver !== "string") throw new Error("Provider is no longer available");
  const instance = record(instances[instanceId]);
  // The reference server permits an implicit default slot whose id is its driver.
  if (!instance && instanceId !== provider.driver) throw new Error("Provider settings are unavailable");
  if (instance && typeof instance.driver !== "string") throw new Error("Provider settings are invalid");
  return { operation: "upsert", instanceId, instance: { ...(instance ?? { driver: provider.driver }), enabled } };
}

/** The scopes `GET /api/auth/session` reports (sessionGrantsScope in packages/contracts/src/auth.ts, for providers:manage). */
export interface SessionGrantShape { authenticated: boolean; scopes?: string[]; permissions?: string[]; auth?: { serverUpdateScope?: string } }

export function parseSessionGrant(value: unknown): SessionGrantShape | null {
  const data = record(value);
  if (!data || typeof data.authenticated !== "boolean") return null;
  const list = (entry: unknown) => Array.isArray(entry) ? entry.filter((item): item is string => typeof item === "string") : undefined;
  const auth = record(data.auth);
  return {
    authenticated: data.authenticated,
    ...(list(data.scopes) ? { scopes: list(data.scopes) } : {}),
    ...(list(data.permissions) ? { permissions: list(data.permissions) } : {}),
    ...(auth && typeof auth.serverUpdateScope === "string" ? { auth: { serverUpdateScope: auth.serverUpdateScope } } : {}),
  };
}

/** sessionGrantsScope(session, AuthProvidersManageScope), including the client-only fallback for old servers. */
export function sessionGrantsProvidersManage(session: SessionGrantShape): boolean {
  if (!session.authenticated) return false;
  if (session.permissions !== undefined) return session.permissions.includes("providers:manage");
  if (session.scopes?.includes("providers:manage")) return true;
  if (session.auth?.serverUpdateScope !== undefined) return false;
  return session.scopes?.includes("orchestration:operate") === true;
}

/** The environment's session over HTTP: what this client may change. Null when it cannot be read. */
export async function fetchSessionGrant(socketUrl: string, bearer: string): Promise<SessionGrantShape | null> {
  const url = new URL(socketUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/api/auth/session"; url.search = ""; url.hash = "";
  const response = await fetch(url.toString(), { headers: { authorization: `Bearer ${bearer}` } });
  return response.ok ? parseSessionGrant(await response.json()) : null;
}

/** sessionGrantsScope for any one scope, with the client-only fallback to orchestration:operate for old servers. */
export function sessionGrantsScope(session: SessionGrantShape, scope: string): boolean {
  if (!session.authenticated) return false;
  if (session.permissions !== undefined) return session.permissions.includes(scope);
  if (session.scopes?.includes(scope)) return true;
  if (session.auth?.serverUpdateScope !== undefined) return false;
  return session.scopes?.includes("orchestration:operate") === true;
}
