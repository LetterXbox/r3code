import { expect, test } from "nsh/test";
import { openRelaySocketUrl } from "./backend/relayRoute";

test("a T3 Connect route: relay connect, DPoP token exchange, DPoP ticket (bare path on 404) and an upgrade proof bound to the ticket", async () => {
  const calls: { url: string; headers: Record<string, string>; body?: string }[] = [];
  const proofs: { method: string; url: string; accessToken?: string }[] = [];
  const fakeFetch = (async (url: string, init: { headers: Record<string, string>; body?: string }) => {
    calls.push({ url, headers: init.headers, body: init.body });
    if (url.endsWith("/oauth/token")) return { ok: true, status: 200, json: async () => ({ access_token: "dpop-access" }) };
    if (url.endsWith("/websocket-ticket/rpc")) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => ({ ticket: "tkt" }) };
  }) as unknown as typeof fetch;
  const result = await openRelaySocketUrl("env-a", {
    connect: async (id) => ({ environmentId: id, endpoint: { httpBaseUrl: "https://a.relay.example", providerKind: "x" }, credential: "boot-cred", expiresAt: "z" }),
    createProof: async (input) => { proofs.push(input); return `proof:${input.method}:${input.url}:${input.accessToken ?? ""}`; },
    fetch: fakeFetch,
  });
  expect(calls[0].url).toBe("https://a.relay.example/oauth/token");
  expect(calls[0].headers.dpop).toBe("proof:POST:https://a.relay.example/oauth/token:");
  expect(new URLSearchParams(calls[0].body).get("subject_token")).toBe("boot-cred");
  expect(new URLSearchParams(calls[0].body).get("subject_token_type")).toBe("urn:t3:params:oauth:token-type:environment-bootstrap");
  expect(calls[1].headers.authorization).toBe("DPoP dpop-access");
  expect(calls[2].url).toBe("https://a.relay.example/api/auth/websocket-ticket");
  expect(calls[2].headers.dpop).toBe("proof:POST:https://a.relay.example/api/auth/websocket-ticket:dpop-access");
  const socket = new URL(result.socketUrl);
  expect(`${socket.protocol}//${socket.host}${socket.pathname}`).toBe("wss://a.relay.example/ws");
  expect(socket.searchParams.get("wsTicket")).toBe("tkt");
  expect(socket.searchParams.get("dpop")).toBe("proof:GET:https://a.relay.example/ws:tkt");
});
