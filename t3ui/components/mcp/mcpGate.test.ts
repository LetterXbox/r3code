import { expect, test } from "nsh/test";
import { afterFailedCheck, resolveMcpGate, type EnvironmentCloudLinkStateResult } from "./mcpGate";

const reachable = { status: "reachable", checkedAt: "2026-11-08T00:00:00.000Z", readyConnections: 4, protocol: "quic" } as const;
const tunnel: EnvironmentCloudLinkStateResult = { linked: true, managedTunnelActive: true, tunnelHostname: "prod-a1.t3coderelay.com" };
const savedTunnel = { httpBaseUrl: "https://prod-b2.t3coderelay.com", wsBaseUrl: "wss://prod-b2.t3coderelay.com", providerKind: "cloudflare_tunnel" } as const;
const open = { signedIn: true, connected: true, approvalCodes: true, canReadRelay: true, linkState: tunnel, linkStateError: null, thisMachine: true, relay: { status: "listed", endpoint: undefined }, reachability: reachable } as Parameters<typeof resolveMcpGate>[0];
const saved = { ...open, thisMachine: false, relay: { status: "listed", endpoint: savedTunnel } } as Parameters<typeof resolveMcpGate>[0];

test("the gate opens on a fresh reachable check, at the tunnel's MCP URL", () => {
  expect(resolveMcpGate(open)).toEqual({ kind: "open", mcpUrl: "https://prod-a1.t3coderelay.com/mcp" });
  // A saved machine's address comes from T3 Connect, not from what it reports itself.
  expect(resolveMcpGate(saved)).toEqual({ kind: "open", mcpUrl: "https://prod-b2.t3coderelay.com/mcp" });
});

test("a disconnected saved machine follows T3 Connect's list", () => {
  const away = { ...saved, connected: false };
  const listed = (availability: "checking" | "online" | "offline" | "error", providerKind = "cloudflare_tunnel") =>
    ({ ...away, relay: { status: "listed", endpoint: { ...savedTunnel, providerKind }, availability } }) as Parameters<typeof resolveMcpGate>[0];
  expect(resolveMcpGate(listed("checking")).kind).toBe("checking");
  expect(resolveMcpGate(listed("offline"))).toEqual({ kind: "disconnected", relay: "offline" });
  expect(resolveMcpGate(listed("error"))).toEqual({ kind: "disconnected", relay: "failed" });
  // T3 Connect refuses to check a publish-only link, so that failure says nothing.
  expect(resolveMcpGate(listed("error", "manual"))).toEqual({ kind: "disconnected", relay: null });
  expect(resolveMcpGate({ ...away, relay: { status: "failed" } })).toEqual({ kind: "disconnected", relay: "failed" });
  expect(resolveMcpGate(listed("online"))).toEqual({ kind: "disconnected", relay: null });
  // This machine's probe outranks a stale publish-only record in that list.
  expect(resolveMcpGate({ ...open, relay: { status: "listed", endpoint: { ...savedTunnel, providerKind: "manual" } } }).kind).toBe("open");
});

test("the gate stays closed until every condition is met", () => {
  const cases: [string, Parameters<typeof resolveMcpGate>[0], string][] = [
    ["not loaded", { ...open, signedIn: undefined }, "checking"],
    ["no T3 Connect sign-in", { ...open, signedIn: false }, "sign-in"],
    ["no permission to read T3 Connect", { ...open, canReadRelay: false }, "no-relay-read"],
    ["a server without approval codes", { ...open, approvalCodes: false }, "update"],
    ["a server still loading its config", { ...open, approvalCodes: undefined }, "checking"],
    ["no tunnel", { ...open, linkState: { ...tunnel, managedTunnelActive: false } }, "turn-on"],
    ["a removed link", { ...open, linkState: { ...tunnel, linkRevoked: true } }, "turn-on"],
    ["a link state that failed to read", { ...open, linkStateError: "boom" }, "error"],
    ["a publish-only link's local address", { ...saved, relay: { status: "listed", endpoint: { ...savedTunnel, httpBaseUrl: "http://127.0.0.1:3773", providerKind: "manual" } } }, "turn-on"],
    ["a saved machine T3 Connect does not list", { ...saved, relay: { status: "listed", endpoint: undefined } }, "turn-on"],
    ["T3 Connect's list still loading", { ...saved, relay: { status: "loading" } }, "checking"],
    ["a disconnected saved machine while the list refreshes", { ...saved, connected: false, relay: { status: "loading" } }, "checking"],
    ["no tunnel, before the list loads", { ...saved, linkState: { ...tunnel, managedTunnelActive: false }, relay: { status: "loading" } }, "turn-on"],
    ["the check still running", { ...open, reachability: "checking" }, "checking"],
    ["an offline tunnel", { ...open, reachability: { status: "unreachable", checkedAt: "2026-11-08T00:00:00.000Z", cause: "no_connector", reason: "Cloudflare has no live connection from this machine for the tunnel.", hint: null, fix: "Restart R3 Code." } }, "offline"],
    ["a failed check", { ...open, reachability: null }, "offline"],
    ["no tunnel address yet", { ...open, linkState: { ...tunnel, tunnelHostname: undefined } }, "offline"],
    ["a hostname that is not a plain DNS name", { ...open, linkState: { ...tunnel, tunnelHostname: "a.com;touch$IFS/tmp/x" } }, "offline"],
  ];
  for (const [name, input, kind] of cases) expect([name, resolveMcpGate(input).kind]).toEqual([name, kind]);
  expect(resolveMcpGate({ ...open, thisMachine: true, connected: false })).toEqual({ kind: "disconnected", relay: null });
});

test("after a failed check, only a newer server check counts", () => {
  const at = (checkedAt: string) => ({ ...tunnel, reachability: { ...reachable, checkedAt } });
  const older = at("2026-11-08T00:00:00.000Z");
  const newer = at("2026-11-08T00:01:00.000Z");
  expect(afterFailedCheck(older, newer)).toEqual({ result: newer.reachability, since: newer.reachability.checkedAt });
  expect(afterFailedCheck(newer, newer)).toEqual({ result: null, since: newer.reachability.checkedAt });
  expect(afterFailedCheck(null, newer)).toEqual({ result: null, since: newer.reachability.checkedAt });
  expect(afterFailedCheck(older, null)).toEqual({ result: null, since: older.reachability.checkedAt });
  expect(afterFailedCheck(null, null)).toEqual({ result: null, since: null });
  expect(afterFailedCheck(tunnel, newer)).toEqual({ result: newer.reachability, since: newer.reachability.checkedAt });
  expect(afterFailedCheck(tunnel, null)).toEqual({ result: null, since: "" });
});
