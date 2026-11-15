// A T3 Connect (relay) route to an environment, 1:1 with the reference's DPoP path:
// - relay/managedRelay.ts connectEnvironment: POST /v1/environments/:id/connect (DPoP) -> endpoint + bootstrap credential
// - authorization/remote.ts exchangeRemoteDpopAccessToken: POST <http>/oauth/token with a DPoP proof -> DPoP-bound token
// - authorization/remote.ts resolveRemoteDpopWebSocketConnectionUrl: POST /api/auth/websocket-ticket/rpc (bare path on
//   404, with its own proof) with `DPoP <token>` + proof, then the socket URL carries wsTicket and a GET upgrade proof
//   bound (ath) to the ticket in the `dpop` query parameter.
import { record } from "./client";
import { appendClientOwnerParams, appendClientSocketParams } from "./auth";

export interface RelayConnectAnswer { environmentId: string; endpoint: { httpBaseUrl: string; wsBaseUrl?: string; providerKind: string }; credential: string; expiresAt: string }
export interface RelayRouteDeps {
  connect: (relayEnvironmentId: string) => Promise<RelayConnectAnswer>;
  createProof: (input: { method: "GET" | "POST"; url: string; accessToken?: string }) => Promise<string>;
  fetch?: typeof fetch;
  clientFields?: Record<string, string>;
}

const endpointUrl = (httpBaseUrl: string, path: string) => `${httpBaseUrl.replace(/\/$/, "")}${path}`;
function rpcSocketUrl(wsBaseUrl: string): URL {
  const url = new URL(wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") url.pathname = "/ws";
  return url;
}
function wsBaseOf(endpoint: RelayConnectAnswer["endpoint"]): string {
  if (endpoint.wsBaseUrl) return endpoint.wsBaseUrl;
  const url = new URL(endpoint.httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** The socket URL for one connection attempt over the relay route (a fresh relay connect, token and ticket each time). */
export async function openRelaySocketUrl(relayEnvironmentId: string, deps: RelayRouteDeps): Promise<{ socketUrl: string; httpBaseUrl: string }> {
  const run = deps.fetch ?? ((input, init) => fetch(input, init));
  const answer = await deps.connect(relayEnvironmentId);
  const httpBaseUrl = answer.endpoint.httpBaseUrl;
  const tokenUrl = endpointUrl(httpBaseUrl, "/oauth/token");
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: answer.credential,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    ...(deps.clientFields ?? {}),
  });
  const tokenResponse = await run(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", dpop: await deps.createProof({ method: "POST", url: tokenUrl }) },
    body: body.toString(),
  });
  if (!tokenResponse.ok) throw new Error(`Environment authorization failed (HTTP ${tokenResponse.status})`);
  const accessToken = record(await tokenResponse.json())?.access_token;
  if (typeof accessToken !== "string" || !accessToken) throw new Error("Environment returned no DPoP access token");
  const ticketAt = async (path: string) => run(endpointUrl(httpBaseUrl, path), {
    method: "POST",
    headers: { authorization: `DPoP ${accessToken}`, dpop: await deps.createProof({ method: "POST", url: endpointUrl(httpBaseUrl, path), accessToken }) },
  });
  let ticketResponse = await ticketAt("/api/auth/websocket-ticket/rpc");
  if (ticketResponse.status === 404) ticketResponse = await ticketAt("/api/auth/websocket-ticket");
  if (!ticketResponse.ok) throw new Error(`Environment authorization failed (HTTP ${ticketResponse.status})`);
  const ticket = record(await ticketResponse.json())?.ticket;
  if (typeof ticket !== "string" || !ticket) throw new Error("Environment returned no connection ticket");
  const url = rpcSocketUrl(wsBaseOf(answer.endpoint));
  const upgradeProof = await deps.createProof({ method: "GET", url: `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}${url.pathname}`, accessToken: ticket });
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("dpop", upgradeProof);
  appendClientSocketParams(url);
  await appendClientOwnerParams(url);
  return { socketUrl: url.toString(), httpBaseUrl };
}
