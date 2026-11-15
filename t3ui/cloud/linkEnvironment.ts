// cloud/linkEnvironment.ts for the primary environment: link it to T3 Connect, unlink it, read its link state and set
// its preferences. The environment's own HTTP routes (/api/connect/*, packages/contracts environmentHttp.ts) run with
// this client's session bearer; the relay's routes run with the T3 Connect OAuth token (relayClient.ts).
import { requestRelayClientInstallConfirmation, reportRelayClientInstallProgress, finishRelayClientInstall } from "../environments/RelayClientInstallDialog";
import { backendBearer, backendUrl, requestBackend, subscribeBackend } from "../store";
import { createEnvironmentLinkChallenge, linkRelayEnvironment, RelayRequestError, unlinkRelayEnvironment } from "./relayClient";
import { connectBearer } from "./connectSession";
import { resolveCloudPublicConfig } from "./publicConfig";

export type CloudLinkMode = "managed" | "publish_only";
export interface CloudLinkState {
  linked: boolean; cloudUserId: string | null; relayUrl: string | null; relayIssuer: string | null; managedTunnelActive?: boolean;
  publishAgentActivity: boolean; holdWebhooksWhileOffline?: boolean; linkRevoked?: boolean; tunnelHostname?: string; linkableHere?: boolean;
}

export class CloudEnvironmentLinkError extends Error {}

const CLOUD_LINK_REQUEST_TIMEOUT_MS = 60_000;

type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
let fetcherForTest: Fetcher | null = null;
export function setEnvironmentFetchForTest(fetcher: Fetcher | null) { fetcherForTest = fetcher; }

export function httpBaseOf(socketUrl: string): string {
  const url = new URL(socketUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = ""; url.search = ""; url.hash = "";
  return url.toString().replace(/\/+$/u, "");
}

async function connectRequest<T>(method: string, path: string, failureMessage: string, body?: unknown): Promise<T> {
  const socketUrl = backendUrl();
  const bearer = backendBearer();
  if (!socketUrl || !bearer) throw new CloudEnvironmentLinkError("The environment is not connected.");
  const fetcher = fetcherForTest ?? (fetch as unknown as Fetcher);
  let response: Awaited<ReturnType<Fetcher>>;
  try {
    response = await Promise.race([
      fetcher(`${httpBaseOf(socketUrl)}${path}`, {
        method,
        headers: { authorization: `Bearer ${bearer}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new CloudEnvironmentLinkError(failureMessage)), CLOUD_LINK_REQUEST_TIMEOUT_MS)),
    ]);
  } catch (error) {
    throw error instanceof CloudEnvironmentLinkError ? error : new CloudEnvironmentLinkError(failureMessage);
  }
  const json = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const detail = json && typeof json.message === "string" ? json.message : null;
    throw new CloudEnvironmentLinkError(detail ? `${failureMessage.replace(/[.:]$/u, "")}: ${detail}` : failureMessage);
  }
  return json as T;
}

export const readCloudLinkState = () => connectRequest<CloudLinkState>("GET", "/api/connect/link-state", "Could not read environment cloud link state.");
export const checkCloudReachability = () => connectRequest<unknown>("POST", "/api/connect/reachability", "Could not check T3 Connect.");
export const updateCloudPreferences = (payload: { publishAgentActivity: boolean; holdWebhooksWhileOffline?: boolean }) =>
  connectRequest<CloudLinkState>("POST", "/api/connect/preferences", "Could not update environment cloud preferences.", payload);

function relayError(prefix: string) {
  return (cause: unknown) => {
    const detail = cause instanceof Error ? cause.message : null;
    return new CloudEnvironmentLinkError(detail ? `${prefix}: ${detail}` : prefix);
  };
}

/** A finite install stream that ends without its `complete` event is "no final status" (Stream.runLast), any other failure a failed install. */
export function relayInstallStreamFailure(error: Error): CloudEnvironmentLinkError {
  return new CloudEnvironmentLinkError(error.message === "Environment subscription ended unexpectedly"
    ? "The relay client install completed without a final status."
    : "Could not install the relay client.");
}

/** ensureRelayClientAvailable: managed tunnels need the environment's relay client, installed with confirmation. */
async function ensureRelayClientAvailable(): Promise<void> {
  const status = await requestBackend("cloud.getRelayClientStatus", {}).catch(() => { throw new CloudEnvironmentLinkError("Could not check relay client availability."); }) as Record<string, unknown>;
  if (status?.status === "available") return;
  if (status?.status === "unsupported") throw new CloudEnvironmentLinkError(`T3 Code cannot install the relay client automatically on ${String(status.platform)}-${String(status.arch)}.`);
  const confirmed = await requestRelayClientInstallConfirmation(String(status?.version ?? "")).catch(() => { throw new CloudEnvironmentLinkError("Could not confirm relay client installation."); });
  if (!confirmed) throw new CloudEnvironmentLinkError("Relay client installation was cancelled.");
  const last = await new Promise<Record<string, unknown> | null>((resolve, reject) => {
    let final: Record<string, unknown> | null = null;
    const stop = subscribeBackend("cloud.installRelayClient", {}, (value) => {
      const event = value as Record<string, unknown>;
      reportRelayClientInstallProgress(event as any);
      final = event;
      if (event?.type === "complete") { stop(); resolve(final); }
    }, (error) => reject(relayInstallStreamFailure(error)));
  }).finally(finishRelayClientInstall);
  if (!last || last.type !== "complete") throw new CloudEnvironmentLinkError("The relay client install completed without a final status.");
  const installed = last.status as Record<string, unknown> | undefined;
  if (installed?.status !== "available") {
    throw new CloudEnvironmentLinkError(installed?.status === "unsupported"
      ? `T3 Code cannot install the relay client automatically on ${String(installed.platform)}-${String(installed.arch)}.`
      : "The relay client is still unavailable after installation.");
  }
}

/** linkEnvironmentToCloud for the primary environment. */
export async function linkEnvironmentToCloud(input: { environmentId: string; mode?: CloudLinkMode }): Promise<void> {
  const relayUrl = resolveCloudPublicConfig().relayUrl;
  if (!relayUrl) throw new CloudEnvironmentLinkError("T3CODE_RELAY_URL is not configured.");
  if (!(await connectBearer())) throw new CloudEnvironmentLinkError("Sign in to T3 Connect before enabling this.");
  const managed = (input.mode ?? "managed") === "managed";
  const providerKind = managed ? "cloudflare_tunnel" : "manual";
  const socketUrl = backendUrl();
  if (!socketUrl) throw new CloudEnvironmentLinkError("The environment is not connected.");
  const httpBaseUrl = httpBaseOf(socketUrl);
  // preparedEndpoint: a non-primary target's ws base is its http base with the ws scheme.
  const endpoint = { httpBaseUrl, wsBaseUrl: httpBaseUrl.replace(/^http/u, "ws") };
  if (managed) await ensureRelayClientAvailable();
  const flags = { notificationsEnabled: true, liveActivitiesEnabled: true, managedTunnelsEnabled: managed };
  const challenge = await createEnvironmentLinkChallenge(flags).catch((cause) => { throw relayError(`${relayUrl}/v1/client/environment-link-challenges failed`)(cause); });
  const port = Number(new URL(httpBaseUrl).port || (httpBaseUrl.startsWith("https:") ? 443 : 80));
  const proof = await connectRequest<unknown>("POST", "/api/connect/link-proof", "Could not obtain environment link proof.", {
    challenge: challenge.challenge, relayIssuer: relayUrl, endpoint: { ...endpoint, providerKind }, origin: { localHttpHost: "127.0.0.1", localHttpPort: port },
  });
  const link = await linkRelayEnvironment({ proof, ...flags }).catch((cause) => { throw relayError(`${relayUrl}/v1/client/environment-links failed`)(cause); }) as Record<string, any>;
  if (link.environmentId !== input.environmentId) throw new CloudEnvironmentLinkError("Relay returned credentials for a different environment.");
  if (link.endpoint?.providerKind !== providerKind) throw new CloudEnvironmentLinkError("Relay returned credentials for a different endpoint provider.");
  await connectRequest<unknown>("POST", "/api/connect/relay-config", "Could not configure environment relay access.", {
    relayUrl, relayIssuer: link.relayIssuer, cloudUserId: link.cloudUserId, environmentCredential: link.environmentCredential,
    cloudMintPublicKey: link.cloudMintPublicKey, endpointRuntime: link.endpointRuntime,
  });
}

/** unlinkEnvironmentFromCloud: the environment forgets its link, then the relay is told when signed in. */
export async function unlinkEnvironmentFromCloud(input: { environmentId: string }): Promise<void> {
  await connectRequest<unknown>("POST", "/api/connect/unlink", "Could not unlink the environment from cloud.");
  if (!resolveCloudPublicConfig().relayUrl || !(await connectBearer())) return;
  try {
    await unlinkRelayEnvironment(input.environmentId);
  } catch (cause) {
    const detail = cause instanceof RelayRequestError ? cause.message : null;
    const prefix = "Disconnected locally, but T3 Connect did not confirm it removed this environment";
    throw new CloudEnvironmentLinkError(detail ? `${prefix}: ${detail}` : prefix);
  }
}
