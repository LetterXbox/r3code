import { expect, test } from "nsh/test";
import {
  endpointLabel, listRelayDevices, listRelayEnvironments, managedTunnelCap, mobileClientNotificationDetail, mobileClientPlatformLabel,
  relayFailureReason, RelayRequestError, setRelayFetchForTest, tunnelUpgradeCopy, unlinkRelayEnvironment,
} from "./relayClient";
import { managedTunnelUsage, relayEnvironments, relayT3ChatLink } from "./accountState";
import { beginConnectSignIn, resetConnectSessionForTest, signOutOfConnect } from "./connectSession";

const env = (id: string, providerKind: string) => ({ environmentId: id, label: id, endpoint: { httpBaseUrl: "https://x", wsBaseUrl: "wss://x", providerKind }, linkedAt: "2026-11-01T00:00:00Z" });

async function signIn() {
  resetConnectSessionForTest();
  const request = await beginConnectSignIn((async () => ({ ok: true, status: 200, json: async () => ({ access_token: "tok", refresh_token: "r", expires_in: 3600 }) })) as any);
  await request.finish("c");
}

test("tunnel caps, upgrade copy and labels match the reference", () => {
  expect(managedTunnelCap({ available: true, link: null })).toEqual({ limit: 3, upgrade: "link" });
  expect(managedTunnelCap({ available: true, link: { email: "a", plan: "pro" } })).toEqual({ limit: 10, upgrade: "premier" });
  expect(managedTunnelCap({ available: false, link: null })).toEqual({ limit: 3, upgrade: null });
  expect(managedTunnelCap({ available: true, link: null, maxTunnelsOverride: 7 })).toEqual({ limit: 7, upgrade: null });
  expect(tunnelUpgradeCopy("link")).toBe("Link T3 Chat Pro for up to 10 tunnels, or Premier for up to 100.");
  expect(endpointLabel(env("a", "cloudflare_tunnel"))).toBe("Managed tunnel");
  expect(endpointLabel(env("a", "manual"))).toBe("Activity publishing only");
  const device = { deviceId: "d", label: "Phone", platform: "ios" as const, iosMajorVersion: 26, appVersion: "1.2", updatedAt: "x",
    notifications: { enabled: true, notifyOnApproval: true, notifyOnInput: false, notifyOnCompletion: true, notifyOnFailure: false }, liveActivities: { enabled: false } };
  expect(mobileClientPlatformLabel(device)).toBe("iOS 26 · T3 Code 1.2");
  expect(mobileClientNotificationDetail(device)).toBe("Alerts enabled for approvals, completions.");
});

test("relay requests carry the bearer and map failures to the reference copy", async () => {
  await signIn();
  const calls: { url: string; method: string; auth: string }[] = [];
  setRelayFetchForTest(async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization });
    if (url.endsWith("/v1/environments")) return { ok: true, status: 200, json: async () => ({ environments: [env("e1", "cloudflare_tunnel"), env("e2", "manual")] }) };
    if (url.endsWith("/v2/client/devices")) return { ok: true, status: 200, json: async () => ({ devices: [] }) };
    if (url.endsWith("/v1/client/t3chat-link")) return { ok: true, status: 200, json: async () => ({ available: true, link: null }) };
    return { ok: false, status: 500, json: async () => ({ _tag: "RelayInternalError", code: "internal_error", reason: "x", traceId: "t" }) };
  });
  expect((await listRelayEnvironments()).length).toBe(2);
  expect(await listRelayDevices()).toEqual([]);
  expect(calls[0]).toEqual({ url: "https://relay.t3.codes/v1/environments", method: "GET", auth: "Bearer tok" });
  let failure: unknown = null;
  try { await unlinkRelayEnvironment("e1"); } catch (error) { failure = error; }
  expect(failure instanceof RelayRequestError).toBe(true);
  expect(relayFailureReason(failure)).toBe("T3 Connect is unavailable. Try again.");
  expect(calls[2].url).toBe("https://relay.t3.codes/v1/client/environment-links/e1");
  await relayEnvironments.refresh();
  await relayT3ChatLink.refresh();
  expect(managedTunnelUsage()).toEqual({ used: 1, limit: 3, upgrade: "link" });
  expect(relayFailureReason(new RelayRequestError("x", null, null, null))).toBe("Could not reach T3 Connect. Check your network.");
  setRelayFetchForTest(null);
  await signOutOfConnect();
});

import { httpBaseOf, linkEnvironmentToCloud, setEnvironmentFetchForTest } from "./linkEnvironment";

test("environment http base comes from the socket url", () => {
  expect(httpBaseOf("ws://127.0.0.1:5000/ws?x=1")).toBe("http://127.0.0.1:5000");
  expect(httpBaseOf("wss://h.example/ws")).toBe("https://h.example");
});

test("linking needs a T3 Connect sign-in first", async () => {
  resetConnectSessionForTest();
  await signOutOfConnect();
  let message = "";
  try { await linkEnvironmentToCloud({ environmentId: "e", mode: "publish_only" }); } catch (error) { message = (error as Error).message; }
  expect(message).toBe("Sign in to T3 Connect before enabling this.");
  setEnvironmentFetchForTest(null);
});

test("a relay client install stream that ends without a complete event reads as no final status", async () => {
  const { relayInstallStreamFailure } = await import("./linkEnvironment");
  expect(relayInstallStreamFailure(new Error("Environment subscription ended unexpectedly")).message).toBe("The relay client install completed without a final status.");
  expect(relayInstallStreamFailure(new Error("Download failed")).message).toBe("Could not install the relay client.");
});
