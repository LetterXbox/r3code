// The relay's client routes this native client can call with its T3 Connect OAuth token (packages/contracts relay.ts
// RelayClientGroup; infra/relay verifyRelayClientBearerToken accepts Clerk OAuth tokens). The DPoP routes (connect to a
// cloud environment, environment status, mobile device registration) need a Clerk session JWT and are not here.
// Error copy from packages/client-runtime relay/errorPresentation.ts and apps/web cloud/relayFailureReason.ts.
import { connectBearer } from "./connectSession";
import { resolveCloudPublicConfig } from "./publicConfig";

export const DEFAULT_MANAGED_TUNNEL_LIMIT = 3;
export const T3CHAT_PLAN_TUNNEL_LIMITS = { pro: 10, premier: 100 } as const;
export const T3CHAT_SUBSCRIPTION_URL = "https://t3.chat/settings/subscription";
export const RELAY_REQUEST_TIMEOUT_MS = 15_000;

export interface RelayEnvironmentRecord { environmentId: string; label: string; endpoint: { httpBaseUrl: string; wsBaseUrl: string; providerKind: string }; linkedAt: string }
export interface RelayDeviceRecord {
  deviceId: string; label: string; platform: "ios" | "android"; iosMajorVersion: number | null; androidApiLevel?: number | null; appVersion: string | null;
  notifications: { enabled: boolean; notifyOnApproval: boolean; notifyOnInput: boolean; notifyOnCompletion: boolean; notifyOnFailure: boolean };
  liveActivities: { enabled: boolean }; updatedAt: string;
}
export interface RelayT3ChatLinkResponse { available: boolean; link: { email: string; plan: "free" | "pro" | "premier" } | null; maxTunnelsOverride?: number }

/** ManagedRelayRequestFailedError's presentation: the line relayFailureReason / relayRequestFailureDetail give. */
export class RelayRequestError extends Error {
  constructor(message: string, readonly status: number | null, readonly traceId: string | null, readonly relayError: Record<string, unknown> | null) { super(message); }
}

const MAX_TUNNELS_MESSAGE = (max: number) => max < T3CHAT_PLAN_TUNNEL_LIMITS.premier
  ? `Relay refused the link: this account already has its maximum of ${max} managed tunnels. Unlink an environment, or link a paid T3 Chat account in your T3 Connect account settings on web or desktop. Pro raises the default limit to ${T3CHAT_PLAN_TUNNEL_LIMITS.pro} and Premier to ${T3CHAT_PLAN_TUNNEL_LIMITS.premier}.`
  : `Relay refused the link: this account already has its maximum of ${max} managed tunnels. Unlink an environment to free one up.`;

/** relayProtectedErrorMessage for the errors the client routes declare. */
export function relayProtectedErrorMessage(error: Record<string, unknown>): string | null {
  switch (error._tag) {
    case "RelayAuthInvalidError":
      return error.reason === "not_authorized" ? "Relay rejected the authenticated request." : "Relay rejected the cloud session token.";
    case "RelayEnvironmentLinkProofExpiredError": return "Relay rejected an expired environment link proof.";
    case "RelayEnvironmentLinkProofInvalidError": return `Relay rejected the environment link proof (${String(error.reason)}).`;
    case "RelayEnvironmentLinkFailedError": return `Relay could not link the environment (${String(error.reason)}).`;
    case "RelayEnvironmentLinkUnavailableError":
      return `Relay cannot provision the managed endpoint (${String(error.reason)}).${error.provisioningStage ? ` Failed stage: ${String(error.provisioningStage)}.` : ""}`;
    case "RelayEnvironmentLinkLimitExceededError": return MAX_TUNNELS_MESSAGE(Number(error.maxTunnels));
    case "RelayInternalError": return `Relay encountered an internal error (${String(error.reason)}).`;
    default: return null;
  }
}

/** relayFailureReason: one short line for an error toast. */
export function relayFailureReason(cause: unknown): string | null {
  if (!(cause instanceof RelayRequestError)) return null;
  if (cause.message === "timeout") return "T3 Connect timed out. Try again.";
  if (cause.status === null) return "Could not reach T3 Connect. Check your network.";
  if (cause.relayError) {
    return cause.relayError._tag === "RelayInternalError" ? "T3 Connect is unavailable. Try again." : relayProtectedErrorMessage(cause.relayError) ?? `Relay returned an unexpected HTTP ${cause.status}.`;
  }
  if (cause.status === 504) return "T3 Connect timed out. Try again.";
  if (cause.status >= 500) return "T3 Connect is unavailable. Try again.";
  return `Relay returned an unexpected HTTP ${cause.status}.`;
}

type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; headers?: { get(name: string): string | null }; json(): Promise<unknown> }>;
let fetcherForTest: Fetcher | null = null;
export function setRelayFetchForTest(fetcher: Fetcher | null) { fetcherForTest = fetcher; }

async function relayRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const relayUrl = resolveCloudPublicConfig().relayUrl;
  if (!relayUrl) throw new RelayRequestError("T3CODE_RELAY_URL is not configured.", null, null, null);
  const token = await connectBearer();
  if (!token) throw new RelayRequestError("Sign in to T3 Connect before enabling this.", 401, null, null);
  const fetcher = fetcherForTest ?? (fetch as unknown as Fetcher);
  let response: Awaited<ReturnType<Fetcher>>;
  try {
    response = await Promise.race([
      fetcher(`${relayUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new RelayRequestError("timeout", null, null, null)), RELAY_REQUEST_TIMEOUT_MS)),
    ]);
  } catch (error) {
    if (error instanceof RelayRequestError) throw error;
    throw new RelayRequestError(error instanceof Error ? error.message : String(error), null, null, null);
  }
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const relayError = json && typeof json === "object" && typeof (json as Record<string, unknown>)._tag === "string" ? json as Record<string, unknown> : null;
    const traceId = typeof relayError?.traceId === "string" ? relayError.traceId : null;
    const message = (relayError && relayProtectedErrorMessage(relayError)) ?? (response.status === 504
      ? "Relay timed out before it finished the request (HTTP 504). Try again in a few minutes. If it keeps failing, copy the trace ID when you report it."
      : `Relay returned an unexpected HTTP ${response.status}.`);
    throw new RelayRequestError(message, response.status, traceId, relayError);
  }
  return json as T;
}

export async function listRelayEnvironments(): Promise<RelayEnvironmentRecord[]> {
  const result = await relayRequest<{ environments?: RelayEnvironmentRecord[] }>("GET", "/v1/environments");
  return Array.isArray(result?.environments) ? result.environments : [];
}

export async function listRelayDevices(): Promise<RelayDeviceRecord[]> {
  const result = await relayRequest<{ devices?: RelayDeviceRecord[] }>("GET", "/v2/client/devices");
  return Array.isArray(result?.devices) ? result.devices : [];
}

export const unlinkRelayEnvironment = (environmentId: string) =>
  relayRequest<{ ok: boolean }>("DELETE", `/v1/client/environment-links/${encodeURIComponent(environmentId)}`);

export const getT3ChatLink = () => relayRequest<RelayT3ChatLinkResponse>("GET", "/v1/client/t3chat-link");
export const createT3ChatLinkRequest = async () => (await relayRequest<{ url: string }>("POST", "/v1/client/t3chat-link-requests")).url;
export const unlinkT3Chat = () => relayRequest<{ ok: boolean }>("DELETE", "/v1/client/t3chat-link");

export const createEnvironmentLinkChallenge = (payload: { notificationsEnabled: boolean; liveActivitiesEnabled: boolean; managedTunnelsEnabled: boolean }) =>
  relayRequest<{ challenge: string }>("POST", "/v1/client/environment-link-challenges", payload);
export const linkRelayEnvironment = (payload: Record<string, unknown>) =>
  relayRequest<Record<string, unknown>>("POST", "/v1/client/environment-links", payload);

// ---- presentation (managedRelayState.ts, TunnelUsage.tsx, MobileClientsUserProfilePage.logic.ts, T3ConnectUserProfilePage.tsx)

export type ManagedTunnelUpgrade = "link" | "pro" | "premier" | null;

export function managedTunnelCap(t3Chat: RelayT3ChatLinkResponse): { limit: number; upgrade: ManagedTunnelUpgrade } {
  if (t3Chat.maxTunnelsOverride !== undefined) return { limit: t3Chat.maxTunnelsOverride, upgrade: null };
  if (!t3Chat.available) return { limit: DEFAULT_MANAGED_TUNNEL_LIMIT, upgrade: null };
  switch (t3Chat.link?.plan) {
    case "premier": return { limit: T3CHAT_PLAN_TUNNEL_LIMITS.premier, upgrade: null };
    case "pro": return { limit: T3CHAT_PLAN_TUNNEL_LIMITS.pro, upgrade: "premier" };
    case "free": return { limit: DEFAULT_MANAGED_TUNNEL_LIMIT, upgrade: "pro" };
    default: return { limit: DEFAULT_MANAGED_TUNNEL_LIMIT, upgrade: "link" };
  }
}

export const managedTunnelsUsed = (environments: readonly RelayEnvironmentRecord[]) =>
  environments.filter((environment) => environment.endpoint.providerKind === "cloudflare_tunnel").length;

export function tunnelUpgradeCopy(upgrade: Exclude<ManagedTunnelUpgrade, null>): string {
  const { pro, premier } = T3CHAT_PLAN_TUNNEL_LIMITS;
  switch (upgrade) {
    case "link": return `Link T3 Chat Pro for up to ${pro} tunnels, or Premier for up to ${premier}.`;
    case "pro": return `Upgrade to T3 Chat Pro for up to ${pro} tunnels, or Premier for up to ${premier}.`;
    case "premier": return `Upgrade to T3 Chat Premier for up to ${premier} tunnels.`;
  }
}

const linkedAtFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
export function linkedAtLabel(value: string): string {
  const linkedAt = new Date(value);
  return Number.isNaN(linkedAt.getTime()) ? "Link date unavailable" : `Linked ${linkedAtFormatter.format(linkedAt)}`;
}
export const endpointLabel = (environment: RelayEnvironmentRecord) =>
  environment.endpoint.providerKind === "cloudflare_tunnel" ? "Managed tunnel" : "Activity publishing only";

const NOTIFICATION_PREFERENCES = [
  ["notifyOnApproval", "approvals"], ["notifyOnInput", "input requests"], ["notifyOnCompletion", "completions"], ["notifyOnFailure", "failures"],
] as const;
export function mobileClientPlatformLabel(device: RelayDeviceRecord): string {
  const platform = device.platform === "android" ? "Android" : device.iosMajorVersion === null ? "iOS" : `iOS ${device.iosMajorVersion}`;
  return `${platform}${device.appVersion ? ` · T3 Code ${device.appVersion}` : ""}`;
}
export function mobileClientNotificationDetail(device: RelayDeviceRecord): string {
  if (!device.notifications.enabled) return "Push notifications are disabled on this device.";
  const enabled = NOTIFICATION_PREFERENCES.flatMap(([preference, label]) => (device.notifications[preference] ? [label] : []));
  return enabled.length > 0 ? `Alerts enabled for ${enabled.join(", ")}.` : "Push notifications are enabled, but no alert types are selected.";
}
const updatedAtFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
export function mobileClientUpdatedAtLabel(updatedAt: string): string {
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime()) ? "Update time unavailable" : `Updated ${updatedAtFormatter.format(date)}`;
}
export function t3ChatPlanLabel(plan: "free" | "pro" | "premier"): string {
  switch (plan) {
    case "premier": return `Premier · up to ${T3CHAT_PLAN_TUNNEL_LIMITS.premier} tunnels`;
    case "pro": return `Pro · up to ${T3CHAT_PLAN_TUNNEL_LIMITS.pro} tunnels. Upgrade on T3 Chat to Premier for ${T3CHAT_PLAN_TUNNEL_LIMITS.premier}.`;
    case "free": return "Upgrade on T3 Chat for more tunnels";
  }
}
