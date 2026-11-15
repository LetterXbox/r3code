import { expect, test } from "nsh/test";
import { connectReachabilityHelpUrl, createCloudLinkController, formatConnectReachable, isManagedTunnelActive } from "./CloudLinkRow";

const base = { linked: false, cloudUserId: null, relayUrl: null, relayIssuer: null, publishAgentActivity: false };

test("reachability copy and the managed-tunnel rule follow the reference", () => {
  expect(formatConnectReachable({ status: "reachable", checkedAt: "", readyConnections: 4, protocol: "quic" })).toBe("Tunnel connected · 4 connections · QUIC");
  expect(connectReachabilityHelpUrl("edge_unreachable")).toBe("https://github.com/pingdotgg/t3code/blob/main/docs/user/t3-connect-troubleshooting.md#port-7844-is-blocked-on-the-host");
  expect(isManagedTunnelActive({ ...base, linked: true }, undefined)).toBe(true);
  expect(isManagedTunnelActive({ ...base, linked: true }, "manual")).toBe(false);
  expect(isManagedTunnelActive({ ...base, linked: true, linkRevoked: true }, undefined)).toBe(false);
});

test("turning T3 Connect on links in managed mode, then saves the preferences; off unlinks", async () => {
  const calls: string[] = [];
  let state = { ...base };
  const controller = createCloudLinkController(() => "env-1", {
    readCloudLinkState: async () => state,
    linkEnvironmentToCloud: async (input) => { calls.push(`link ${input.mode}`); state = { ...state, linked: true }; },
    unlinkEnvironmentFromCloud: async () => { calls.push("unlink"); state = { ...base }; },
    updateCloudPreferences: async (payload) => { calls.push(`prefs ${JSON.stringify(payload)}`); state = { ...state, publishAgentActivity: payload.publishAgentActivity }; return state; },
  });
  await controller.refresh();
  expect(await controller.reconcile({ managedTunnel: true, publish: false })).toBe(true);
  expect(controller.managedTunnelActive()).toBe(true);
  expect(await controller.reconcile({ managedTunnel: false, publish: false })).toBe(true);
  expect(calls).toEqual(["link managed", 'prefs {"publishAgentActivity":false}', "unlink"]);
});

test("a failed unlink that the relay kept says to remove it in Account", async () => {
  const controller = createCloudLinkController(() => "env-1", {
    readCloudLinkState: async () => ({ ...base, linked: true }),
    linkEnvironmentToCloud: async () => undefined,
    unlinkEnvironmentFromCloud: async () => { throw new Error("Disconnected locally, but T3 Connect did not confirm it removed this environment"); },
    updateCloudPreferences: async () => base,
  });
  await controller.refresh();
  expect(await controller.reconcile({ managedTunnel: false, publish: false })).toBe(false);
  expect(controller.operationError()).toBe("Disconnected locally, but T3 Connect did not confirm it removed this environment");
});
