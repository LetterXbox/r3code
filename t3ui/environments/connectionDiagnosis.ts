// packages/client-runtime/src/connection/diagnosis.ts and the parts of model.ts it reads: what failed on the way to an
// environment, hop by hop, what to try, and the facts for a bug report. The model is the reference's; the port's
// connection manager (connectionManager.ts) fills the failure the same way the reference's supervisor does, through
// classifyConnectionFailure below. Saved environments here are direct routes (no T3 Connect relay route yet), so the
// relay status input is accepted but normally absent.

export type ConnectionHop = "device" | "relay" | "tunnel" | "server";
export type ConnectionFailureCause =
  | "dns" | "tls" | "refused" | "timeout" | "origin_unreachable" | "invalid_response" | "tunnel_down" | "unknown"
  | "clock_skew" | "not_linked" | "relay_error" | "tunnel_pending" | "tunnel_not_enabled";
export type ConnectionTransientReason = "network" | "timeout" | "transport" | "endpoint-unavailable" | "relay-unavailable" | "remote-unavailable" | "session-pending";
export type ConnectionBlockedReason = "authentication" | "configuration" | "permission" | "unsupported";

interface FailureFields { hop?: ConnectionHop; via?: "relay" | "direct"; failureCause?: ConnectionFailureCause; httpStatus?: number; detail: string; traceId?: string }
export type ConnectionAttemptError =
  | (FailureFields & { _tag: "ConnectionTransientError"; reason: ConnectionTransientReason })
  | (FailureFields & { _tag: "ConnectionBlockedError"; reason: ConnectionBlockedReason; serverUpdateRequired?: boolean });

export interface SupervisorConnectionState {
  network: "online" | "offline" | "unknown";
  phase: "available" | "offline" | "connecting" | "backoff" | "connected" | "blocked";
  attempt: number;
  lastFailure: ConnectionAttemptError | null;
  retryAt: number | null;
}

export type ConnectionHopResult = "ok" | "failed" | "unchecked";
export interface ConnectionDiagnosisHop { hop: ConnectionHop; label: string; result: ConnectionHopResult }
export interface ConnectionDiagnosis {
  headline: string;
  hops: ConnectionDiagnosisHop[];
  steps: string[];
  facts: (readonly [string, string])[];
  moreInfoUrl: string | null;
}

export interface RelayStatusSummary { status: string; endpointFailure?: ConnectionFailureCause | null; endpointStatus?: number | null; offlineReason?: string | null }
export interface ConnectionDiagnosisInput {
  hostLabel: string;
  state: SupervisorConnectionState;
  via: "relay" | "direct";
  relayStatus?: RelayStatusSummary | null;
  clientVersion?: string | undefined;
  serverVersion?: string | null | undefined;
}

type LocatedCause = ConnectionFailureCause | "offline" | "outdated" | "released" | "session_pending" | null;
interface Located { hop: ConnectionHop; cause: LocatedCause; guessed?: true }

const NOT_ANSWERING: ReadonlySet<ConnectionFailureCause> = new Set(["origin_unreachable", "invalid_response"]);

/** t3ConnectTroubleshootingUrl (contracts environmentHttp.ts). */
export const t3ConnectTroubleshootingUrl = (section: string) => `https://github.com/pingdotgg/t3code/blob/main/docs/user/t3-connect-troubleshooting.md#${section}`;

function locate(input: ConnectionDiagnosisInput): Located | null {
  const failure = input.state.lastFailure;
  if (input.state.network === "offline" || input.state.phase === "offline") return { hop: "device", cause: "offline" };
  if (failure?._tag === "ConnectionBlockedError" && failure.serverUpdateRequired) return { hop: "server", cause: "outdated" };
  if (failure?.reason === "session-pending") return { hop: "device", cause: "session_pending" };
  if (failure?.hop !== undefined) return { hop: failure.hop, cause: failure.failureCause ?? null };
  if (failure !== null) {
    const unreachable = failure.reason === "network" || failure.reason === "timeout" || failure.reason === "transport";
    const via = failure.via ?? input.via;
    return { hop: unreachable && via === "relay" ? "tunnel" : "server", cause: null, guessed: true };
  }
  const status = input.relayStatus;
  if (status?.status !== "offline") return null;
  if (status.offlineReason === "tunnel_released") return { hop: "tunnel", cause: "released" };
  const cause = status.endpointFailure ?? null;
  return { hop: cause !== null && NOT_ANSWERING.has(cause) ? "server" : "tunnel", cause };
}

const onThisDevice = (failure: ConnectionAttemptError | null) => failure?.reason === "network" || failure?.reason === "transport" || failure?.reason === "timeout";

function headline(host: string, located: Located, failure: ConnectionAttemptError | null): string {
  switch (located.cause) {
    case "offline": return "This device is offline";
    case "session_pending": return "This device is still loading its T3 Connect sign-in";
    case "outdated": return `${host} runs an older T3 Code`;
    case "clock_skew": return "This device's clock is off";
    case "not_linked": return `${host} is not linked to your T3 Connect account`;
    case "relay_error": return "T3 Connect returned an error";
    case "tunnel_pending": return `${host}'s tunnel is still being set up`;
    case "tunnel_not_enabled": return `T3 Connect is not turned on for ${host}`;
    case "released":
    case "tunnel_down": return `${host}'s tunnel is offline`;
    case "origin_unreachable": return `Tunnel works, but T3 Code on ${host} did not answer`;
    case "invalid_response": return `T3 Code on ${host} sent an unexpected answer`;
    case "dns": return `${host}'s tunnel address did not resolve`;
    case "tls": return `Secure connection to ${host}'s tunnel failed`;
    case "refused": return `${host}'s tunnel refused the connection`;
    case "timeout": return `${host} did not answer in time`;
    case "unknown":
    case null: break;
  }
  switch (located.hop) {
    case "device": return "This device could not prepare the connection";
    case "relay": return failure?.reason === "authentication" ? "T3 Connect did not accept this device's sign-in" : "This device can't reach T3 Connect";
    case "tunnel": return onThisDevice(failure) ? `This device can't reach ${host}'s tunnel` : `T3 Connect could not reach ${host}'s tunnel`;
    case "server": return failure?.reason === "authentication" || failure?.reason === "permission" ? `T3 Code on ${host} did not accept this device` : `T3 Code on ${host} did not answer`;
  }
}

function steps(host: string, located: Located, failure: ConnectionAttemptError | null): string[] {
  const checkHost = `On ${host}, check Settings > Sharing & access or run \`t3 connect status\`.`;
  switch (located.cause) {
    case "offline": return ["Connect this device to the internet. T3 Code reconnects on its own."];
    case "session_pending": return ["Wait a moment. T3 Code retries on its own.", "If it keeps waiting, reload or restart T3 Code on this device."];
    case "outdated": return [`Update T3 Code on ${host}.`];
    case "clock_skew": return [`Turn on automatic date and time on this device and on ${host}, then retry.`];
    case "not_linked": return ["Check that this device is signed in to the same T3 Connect account as the host.", `On ${host}, open Settings > Sharing & access and turn T3 Connect on.`];
    case "tunnel_pending": return ["Wait a minute. T3 Code retries on its own.", checkHost];
    case "relay_error": return ["Wait a few minutes. T3 Code retries on its own.", "If it keeps failing, copy the diagnostics and report it."];
    case "tunnel_not_enabled": return [`On ${host}, open Settings > Sharing & access and turn T3 Connect on.`];
    case "released":
    case "tunnel_down": return [`Make sure ${host} is awake and T3 Code is running on it.`, checkHost, `A VPN or Tailscale exit node on ${host} can block the tunnel (port 7844). Turn it off or allow the tunnel.`];
    case "origin_unreachable":
    case "invalid_response": return [`Open or restart T3 Code on ${host}.`, checkHost];
    case "dns":
    case "tls":
    case "refused":
    case "timeout":
    case "unknown": return [`Make sure ${host} is awake and online.`, checkHost];
    case null: break;
  }
  switch (located.hop) {
    case "device": return ["Restart T3 Code on this device.", `If it keeps failing, remove ${host} from this device and add it again.`];
    case "relay": return failure?.reason === "authentication" ? ["Sign out of T3 Connect and sign in again."] : ["Check this device's internet connection.", "A VPN, firewall, or ad blocker on this device can block T3 Connect."];
    case "tunnel": return onThisDevice(failure)
      ? ["A VPN, firewall, or DNS filter on this device can block the tunnel.", "Try another network, or add a direct route such as a Tailscale address."]
      : [`Make sure ${host} is awake and online.`, checkHost];
    case "server": return [`Make sure T3 Code is running on ${host}.`, "Retry. If it keeps failing, copy the diagnostics."];
  }
}

function helpSection(located: Located, failure: ConnectionAttemptError | null): string {
  switch (located.cause) {
    case "offline": return "this-device-cant-reach-t3-connect";
    case "outdated": return "the-host-runs-an-older-t3-code";
    case "clock_skew": return "the-clock-is-off";
    case "session_pending":
    case "not_linked":
    case "tunnel_not_enabled": return "sign-in-account-or-link-problems";
    case "relay_error": return "t3-connect-returned-an-error";
    case "released":
    case "tunnel_down":
    case "tunnel_pending": return "the-hosts-tunnel-is-offline";
    case "origin_unreachable":
    case "invalid_response": return "the-tunnel-works-but-t3-code-does-not-answer";
    case "dns":
    case "tls":
    case "refused":
    case "timeout":
    case "unknown": return "the-t3-connect-address-does-not-resolve-or-answer";
    case null: break;
  }
  switch (located.hop) {
    case "device": return "this-device-cant-reach-t3-connect";
    case "relay": return failure?.reason === "authentication" ? "sign-in-account-or-link-problems" : "this-device-cant-reach-t3-connect";
    case "tunnel": return onThisDevice(failure) ? "this-device-cant-reach-t3-connect" : "the-hosts-tunnel-is-offline";
    case "server": return failure?.reason === "authentication" || failure?.reason === "permission" ? "sign-in-account-or-link-problems" : "the-tunnel-works-but-t3-code-does-not-answer";
  }
}

const HOP_ORDER: Record<"relay" | "direct", readonly ConnectionHop[]> = { relay: ["device", "relay", "tunnel", "server"], direct: ["device", "server"] };

function hopLabel(hop: ConnectionHop, host: string): string {
  switch (hop) {
    case "device": return "This device";
    case "relay": return "T3 Connect";
    case "tunnel": return `${host} tunnel`;
    case "server": return `T3 Code on ${host}`;
  }
}

/** What failed, in order, and what to try; null when nothing has failed. */
export function presentConnectionDiagnosis(input: ConnectionDiagnosisInput): ConnectionDiagnosis | null {
  const located = locate(input);
  if (located === null) return null;
  const host = input.hostLabel;
  const failure = input.state.lastFailure;
  const relayPath = located.hop === "relay" || located.hop === "tunnel" || (failure === null && input.relayStatus?.status === "offline") || (failure?.via ?? input.via) === "relay";
  const order = HOP_ORDER[relayPath ? "relay" : "direct"];
  const failedIndex = order.indexOf(located.hop);
  const hops = order.map((hop, index): ConnectionDiagnosisHop => ({
    hop,
    label: hopLabel(hop, host),
    result: index === failedIndex ? "failed" : index < failedIndex && located.guessed !== true ? "ok" : "unchecked",
  }));
  const httpStatus = failure !== null ? failure.httpStatus : input.relayStatus?.endpointStatus;
  const facts: (readonly [string, string])[] = [];
  const add = (label: string, value: string | number | null | undefined) => { if (value !== null && value !== undefined && value !== "") facts.push([label, String(value)]); };
  add("Cause", located.cause ?? failure?.reason);
  add("HTTP status", httpStatus);
  add("Attempts", input.state.attempt > 0 ? input.state.attempt : null);
  add("Next retry", input.state.retryAt === null ? null : new Date(input.state.retryAt).toISOString());
  add("Route", relayPath ? "T3 Connect" : "Direct");
  add("App version", input.clientVersion);
  add("Host version", input.serverVersion);
  add("Error", failure?.detail);
  add("Trace ID", failure?.traceId);
  return {
    headline: headline(host, located, failure),
    hops,
    steps: steps(host, located, failure),
    facts,
    moreInfoUrl: relayPath || located.cause === "session_pending" ? t3ConnectTroubleshootingUrl(helpSection(located, failure)) : null,
  };
}

const HOP_MARK = { ok: "ok", failed: "FAILED", unchecked: "not checked" } as const;

/** One plain-text block for bug reports. */
export function connectionDiagnosisText(hostLabel: string, diagnosis: ConnectionDiagnosis): string {
  return [
    `T3 Code connection to ${hostLabel}: ${diagnosis.headline}`,
    "",
    ...diagnosis.hops.map((hop) => `${hop.label}: ${HOP_MARK[hop.result]}`),
    "",
    ...diagnosis.facts.map(([label, value]) => `${label}: ${value}`),
    ...(diagnosis.moreInfoUrl ? ["", `More info: ${diagnosis.moreInfoUrl}`] : []),
  ].join("\n");
}

/**
 * The supervisor's attempt errors, from what the port's direct connection saw: a refused session is blocked
 * (authentication, or permission on 403), an outdated server is blocked with serverUpdateRequired, a fetch that never
 * answered is a network failure, a timeout a timeout, a 5xx the remote being unavailable, and a socket that closed a
 * transport failure. All are on the direct route to T3 Code on the host unless the error names the device.
 */
export function classifyConnectionFailure(error: unknown): ConnectionAttemptError {
  const detail = error instanceof Error ? error.message : String(error);
  const traceId = typeof (error as { traceId?: unknown } | null)?.traceId === "string" ? (error as { traceId: string }).traceId : undefined;
  const http = /HTTP (\d{3})/.exec(detail);
  const httpStatus = http ? Number(http[1]) : undefined;
  const base = { detail, via: "direct" as const, ...(traceId ? { traceId } : {}), ...(httpStatus !== undefined ? { httpStatus } : {}) };
  // cloud/connectSession.ts SIGN_IN_TO_CONNECT_ENVIRONMENT_DETAIL (this module stays free of imports).
  if (detail === "Sign in to T3 Connect to connect this environment.") return { _tag: "ConnectionBlockedError", reason: "authentication", ...base, via: "relay" };
  if (/Pairing expired|authorization expired/i.test(detail) || httpStatus === 401) return { _tag: "ConnectionBlockedError", reason: "authentication", hop: "server", ...base };
  if (httpStatus === 403) return { _tag: "ConnectionBlockedError", reason: "permission", hop: "server", ...base };
  if (/requires a newer|update required|server update/i.test(detail)) return { _tag: "ConnectionBlockedError", reason: "unsupported", serverUpdateRequired: true, ...base };
  if (httpStatus !== undefined && httpStatus >= 500) return { _tag: "ConnectionTransientError", reason: "remote-unavailable", ...base };
  if (/timed? ?out|ETIMEDOUT/i.test(detail)) return { _tag: "ConnectionTransientError", reason: "timeout", ...base };
  if (/socket|closed|websocket/i.test(detail)) return { _tag: "ConnectionTransientError", reason: "transport", ...base };
  return { _tag: "ConnectionTransientError", reason: "network", ...base };
}
