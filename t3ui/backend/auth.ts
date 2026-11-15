import { platform } from "nsh";
import { record } from "./client";

export function clientOsName(os: string | undefined): string | null {
  switch (os) {
    case "macos": return "macOS";
    case "windows": return "Windows";
    case "linux": return "Linux";
    default: return null;
  }
}

function clientOsField(): Record<string, string> {
  const name = clientOsName(platform?.os);
  return name ? { client_os: name } : {};
}

function httpBase(socketUrl: string): string {
  const url = new URL(socketUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/** Exchange a one-time pairing credential; never place it in a URL or persistent storage. */
export async function exchangePairingToken(socketUrl: string, credential: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: credential,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    client_label: "T3 Code GPUI",
    client_device_type: "desktop",
    // clientMetadataTokenExchangeFields: the OS, unless unknown/other (clientOsFromElectronPlatform names).
    ...clientOsField(),
  });
  const response = await fetch(`${httpBase(socketUrl)}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(),
  });
  if (!response.ok) throw await withTraceId(new Error(`Pairing failed (HTTP ${response.status})`), response);
  const result = record(await response.json());
  if (!result || typeof result.access_token !== "string" || !result.access_token) throw new Error("Pairing returned no session token");
  return result.access_token;
}

/** environments/primary/auth.ts PrimaryEnvironmentAuthSessionTimeoutError's message. */
export const AUTH_SESSION_TIMEOUT_MESSAGE = "Timed out waiting for authenticated session after bootstrap.";
const AUTH_SESSION_ESTABLISH_TIMEOUT_MS = 2_000;
const AUTH_SESSION_ESTABLISH_STEP_MS = 100;
const TRANSIENT_BOOTSTRAP_STATUS_CODES = new Set([502, 503, 504]);
const BOOTSTRAP_RETRY_TIMEOUT_MS = 15_000;
const BOOTSTRAP_RETRY_STEP_MS = 500;

export interface SessionWaitDeps {
  fetcher: (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const defaultSessionWaitDeps: SessionWaitDeps = {
  fetcher: (url, init) => fetch(url, init),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** waitForAuthenticatedSessionAfterBootstrap: after the bootstrap exchange, the session must read authenticated within 2 s
 * (100 ms steps). Each read retries 502/503/504 and network failures for 15 s (retryTransientBootstrap). */
export async function waitForAuthenticatedSession(socketUrl: string, bearer: string, deps: SessionWaitDeps = defaultSessionWaitDeps): Promise<void> {
  const url = `${httpBase(socketUrl)}/api/auth/session`;
  const readSession = async (): Promise<boolean> => {
    const startedAt = deps.now();
    while (true) {
      let transient: Error;
      try {
        const response = await deps.fetcher(url, { headers: { authorization: `Bearer ${bearer}` } });
        if (response.ok) return record(await response.json())?.authenticated === true;
        const error = new Error(`Primary environment request failed during fetch-session-state (HTTP ${response.status}).`);
        if (!TRANSIENT_BOOTSTRAP_STATUS_CODES.has(response.status)) throw error;
        transient = error;
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        transient = error;
      }
      if (deps.now() - startedAt >= BOOTSTRAP_RETRY_TIMEOUT_MS) throw transient;
      await deps.sleep(BOOTSTRAP_RETRY_STEP_MS);
    }
  };
  const startedAt = deps.now();
  while (true) {
    if (await readSession()) return;
    if (deps.now() - startedAt >= AUTH_SESSION_ESTABLISH_TIMEOUT_MS) throw new Error(AUTH_SESSION_TIMEOUT_MESSAGE);
    await deps.sleep(AUTH_SESSION_ESTABLISH_STEP_MS);
  }
}

/** Each socket connection receives a fresh server-issued ticket. */
export async function issueSocketUrl(socketUrl: string, bearer: string): Promise<string> {
  const base = httpBase(socketUrl);
  let response = await fetch(`${base}/api/auth/websocket-ticket/rpc`, {
    method: "POST", headers: { authorization: `Bearer ${bearer}` },
  });
  if (response.status === 404) {
    response = await fetch(`${base}/api/auth/websocket-ticket`, {
      method: "POST", headers: { authorization: `Bearer ${bearer}` },
    });
  }
  if (!response.ok) throw await withTraceId(new Error(`Environment authorization failed (HTTP ${response.status})`), response);
  const result = record(await response.json());
  if (!result || typeof result.ticket !== "string" || !result.ticket) throw new Error("Environment returned no connection ticket");
  const url = new URL(socketUrl);
  url.searchParams.set("wsTicket", result.ticket);
  appendClientSocketParams(url);
  await appendClientOwnerParams(url);
  return url.toString();
}

/** Set by cloud/connectSession wiring: the signed-in T3 Connect account id, or null. */
let connectAccountId: () => string | null = () => null;
export function setClientOwnerAccount(read: () => string | null) { connectAccountId = read; }
/** shared/telemetryId.ts hashTelemetryId: lowercase hex SHA-256. */
async function hashTelemetryId(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
/**
 * authorization/remote.ts readClientOwnerParams: `clientOwner` is the hashed T3 Connect account (only the hash leaves).
 * `clientDevice` (the analytics device id) is not sent: this client keeps no analytics device id.
 */
export async function appendClientOwnerParams(url: URL) {
  const account = connectAccountId();
  if (account) url.searchParams.set("clientOwner", await hashTelemetryId(account));
}

/**
 * connection/compatibility.ts appendOrchestrationProtocol (protocol 2, clientCapabilities=settingsSecretReferences) and authorization/remote.ts appendClientConnectionParams
 * (clientSurface, clientDeviceType, clientOs), on every socket URL this client opens.
 */
export function appendClientSocketParams(url: URL) {
  url.searchParams.set("orchestrationProtocol", "2");
  // packages/shared socketFrameParts.ts: without frameParts the server sends each RPC
  // message as one frame, and a snapshot larger than the host socket accepts closes it.
  url.searchParams.set("frameParts", "1");
  // settingsSecretReferences: settings secret references arrive as { provider, reference } (pages/settings/secretSource.ts,
  // SecretSourceInput.tsx) instead of being redacted.
  url.searchParams.set("clientCapabilities", "settingsSecretReferences");
  url.searchParams.set("clientSurface", "desktop");
  url.searchParams.set("clientDeviceType", "desktop");
  const os = clientOsName(platform?.os);
  if (os) url.searchParams.set("clientOs", os);
}

/** The environment's HTTP errors (contracts environmentHttp.ts) carry a `traceId` in their JSON body; it is kept on the
 * thrown error so the environment row can offer Copy trace ID (SavedEnvironmentRows.tsx). */
export async function withTraceId(error: Error, response: { json(): Promise<unknown> }): Promise<Error & { traceId?: string }> {
  try {
    const body = record(await response.json());
    if (body && typeof body.traceId === "string" && body.traceId.trim()) (error as Error & { traceId?: string }).traceId = body.traceId.trim();
  } catch {
    // A body that is not JSON has no trace id.
  }
  return error;
}
