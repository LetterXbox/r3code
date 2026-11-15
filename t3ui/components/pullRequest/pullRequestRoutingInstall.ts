// Installs the pull request router (pullRequestRouting.ts) in front of requestBackend: the environments it can route
// between are the primary connection and the saved environments the connection manager holds, with the trust set in
// Settings > Connections (PullRequestRoutingSettings.tsx).
import { backendStatus, backendUrl, requestBackendUnrouted, setPullRequestRouter, supportsPullRequestChecks } from "../../store";
import { environmentConfigs, environmentConnections, managedEnvironment, managedEnvironmentIds, parseScopedKey, requestEnvironment, routePayload, scopeResult } from "../../environments/connectionManager";
import { savedEnvironments } from "../../pages/settings/environments/savedEnvironments";
import { pullRequestRoutingPermissionFor, pullRequestRoutingPermissions } from "../../pages/settings/environments/PullRequestRoutingSettings";
import { createPullRequestRouter, routedPullRequestMethods, type RoutingEnvironment } from "./pullRequestRouting";

/** The primary connection's id in routing (it has no scoped key). */
export const PRIMARY_ROUTING_ENVIRONMENT = "primary";

function isLocalUrl(url: string): boolean {
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname); } catch { return false; }
}

export function routingEnvironments(): RoutingEnvironment[] {
  const permissions = pullRequestRoutingPermissions();
  const out: RoutingEnvironment[] = [];
  const primary = backendUrl();
  if (primary) {
    out.push({
      id: PRIMARY_ROUTING_ENVIRONMENT, enabled: true, supported: true, local: isLocalUrl(primary),
      permission: pullRequestRoutingPermissionFor({ environmentId: primary, urls: [primary] }, permissions),
      connected: backendStatus() === "connected", supportsChecks: supportsPullRequestChecks(),
    });
  }
  for (const id of managedEnvironmentIds()) {
    const environment = managedEnvironment(id);
    if (!environment) continue;
    const saved = savedEnvironments().find((item) => item.url === environment.url);
    const urls = saved?.ssh ? [`ssh://${saved.ssh.target.alias}/${saved.ssh.target.hostname}/${saved.ssh.target.username ?? ""}/${saved.ssh.target.port ?? ""}`] : [environment.url, ...(saved?.alternateUrls ?? [])];
    const phase = environmentConnections()[id]?.phase;
    const capabilities = (environmentConfigs()[id]?.environment as { capabilities?: Record<string, unknown> } | undefined)?.capabilities;
    out.push({
      id, enabled: environment.enabled, supported: phase !== "unsupported", local: isLocalUrl(environment.url),
      permission: pullRequestRoutingPermissionFor({ environmentId: environment.url, urls }, permissions),
      connected: phase === "connected", supportsChecks: capabilities?.pullRequestChecks === true,
    });
  }
  return out;
}

/** A scoped project id ("<environment>:<id>") read by another environment is that environment's local id. */
function unscoped(input: unknown): unknown {
  if (typeof input !== "object" || input === null || typeof (input as { projectId?: unknown }).projectId !== "string") return input;
  const parsed = parseScopedKey((input as { projectId: string }).projectId);
  return parsed ? { ...input, projectId: parsed.localId } : input;
}

let installed = false;

export function installPullRequestRouting() {
  if (installed) return;
  installed = true;
  const router = createPullRequestRouter({
    environments: routingEnvironments,
    request: (environmentId, tag, input) => {
      const origin = routePayload(input)?.environmentId ?? PRIMARY_ROUTING_ENVIRONMENT;
      if (environmentId === origin) return requestBackendUnrouted(tag, input);
      if (environmentId === PRIMARY_ROUTING_ENVIRONMENT) return requestBackendUnrouted(tag, unscoped(input));
      return requestEnvironment(environmentId, tag, unscoped(input)).then((value) => scopeResult(environmentId, value));
    },
  });
  setPullRequestRouter((method, payload, options) => {
    if (!routedPullRequestMethods.has(method)) return requestBackendUnrouted(method, payload, options);
    let origin = PRIMARY_ROUTING_ENVIRONMENT;
    try { origin = routePayload(payload)?.environmentId ?? PRIMARY_ROUTING_ENVIRONMENT; } catch { /* the unrouted request reports it */ }
    return router(origin, method, payload);
  });
}
