import { expect, test } from "nsh/test";
import {
  buildHostedPairingUrl, endpointCopyOptions, endpointDefaultPreferenceKey, endpointShareHint, isHostedAppPairingUrl, isLoopbackHostname, isQrShareableEndpoint,
  isTailscaleHttpsEndpoint, isWslSettingsRowVisible, missingTailscaleEndpointDescription, networkAccessWithoutBridge, resolveAccessEnvironmentId,
  resolveAdvertisedEndpointPairingUrl, resolveTailscaleServeBaseUrl, selectPairingEndpoint, selectQrEndpointOption, sessionPermissionsUnavailableMessage,
  shareablePairingUrl, togglePairingScopeSelection, type AdvertisedEndpoint,
} from "./connectionsLogic";

const endpoint = (id: string, over: Partial<AdvertisedEndpoint> = {}): AdvertisedEndpoint => ({
  id, label: id, provider: { id: "desktop-core" }, httpBaseUrl: "http://192.168.1.5:3773", reachability: "lan",
  compatibility: { hostedHttpsApp: "mixed-content-blocked" }, status: "available", ...over,
});

test("pairing urls carry the credential in the hash and the hosted link only for https", () => {
  expect(resolveAdvertisedEndpointPairingUrl(endpoint("desktop-lan:1"), "abc")).toBe("http://192.168.1.5:3773/pair#token=abc");
  const https = endpoint("tailscale-magicdns:1", { httpBaseUrl: "https://box.tail.ts.net", compatibility: { hostedHttpsApp: "compatible" }, reachability: "private-network" });
  const hosted = resolveAdvertisedEndpointPairingUrl(https, "abc");
  expect(hosted.startsWith("https://app.t3.codes/pair?host=")).toBe(true);
  expect(isHostedAppPairingUrl(hosted)).toBe(true);
  expect(isHostedAppPairingUrl("http://192.168.1.5:3773/pair#token=abc")).toBe(false);
  expect(buildHostedPairingUrl({ host: "https://x.dev", token: "t", label: " Mac " })).toContain("label=Mac");
});

test("the default endpoint prefers the saved key, then the flagged one, then a non-loopback one", () => {
  const loop = endpoint("desktop-loopback:1", { reachability: "loopback", httpBaseUrl: "http://127.0.0.1:3773" });
  const lan = endpoint("desktop-lan:1");
  const down = endpoint("tailscale-ip:1", { status: "unavailable" });
  expect(selectPairingEndpoint([loop, lan, down], null)?.id).toBe("desktop-lan:1");
  expect(selectPairingEndpoint([loop, lan], "desktop-core:loopback:http")?.id).toBe("desktop-loopback:1");
  expect(selectPairingEndpoint([loop, lan, endpoint("x", { isDefault: true })], null)?.id).toBe("x");
  expect(selectPairingEndpoint([down], null)).toBeNull();
  expect(endpointDefaultPreferenceKey(lan)).toBe("desktop-core:lan:http");
  expect(isTailscaleHttpsEndpoint(endpoint("tailscale-magicdns:1"))).toBe(true);
});

test("a loopback endpoint is no QR target, and the share hint names who can reach it", () => {
  expect(isQrShareableEndpoint(endpoint("a", { reachability: "loopback" }))).toBe(false);
  expect(isQrShareableEndpoint(endpoint("a"))).toBe(true);
  expect(endpointShareHint({ reachability: "lan" }, "http://x/pair")).toBe("Devices on the same network");
  expect(endpointShareHint({ reachability: "public" }, "http://x/pair")).toBe("Reachable from anywhere");
  expect(endpointShareHint({ reachability: "loopback" }, "http://x/pair")).toBe("Clients on this machine");
  expect(endpointShareHint({ reachability: "lan" }, "https://app.t3.codes/pair?host=h#token=t")).toBe("Opens the hosted app, no install needed");
});

test("the endpoint selector lists every available endpoint and picks the QR one", () => {
  const options = endpointCopyOptions([endpoint("desktop-loopback:1", { reachability: "loopback", httpBaseUrl: "http://127.0.0.1:3773" }), endpoint("desktop-lan:1"), endpoint("x", { status: "unavailable" })], "abc");
  expect(options.map((option) => option.id)).toEqual(["desktop-loopback:1", "desktop-lan:1"]);
  expect(endpointCopyOptions([endpoint("a")], undefined)).toEqual([]);
  expect(selectQrEndpointOption(options, null, null)?.id).toBe("desktop-lan:1");
  expect(selectQrEndpointOption(options, "desktop-loopback:1", null)?.id).toBe("desktop-loopback:1");
  expect(selectQrEndpointOption(options, null, "desktop-core:loopback:http")?.id).toBe("desktop-loopback:1");
});

test("a pairing row shares the endpoint link, else the endpoint url, else a non-loopback origin", () => {
  const base = { credential: "abc", endpoints: [] as AdvertisedEndpoint[], defaultEndpointKey: null, endpointUrl: null, currentOrigin: null };
  expect(shareablePairingUrl({ ...base, endpoints: [endpoint("desktop-lan:1")] })).toBe("http://192.168.1.5:3773/pair#token=abc");
  expect(shareablePairingUrl({ ...base, endpointUrl: "http://10.0.0.2:3773" })).toBe("http://10.0.0.2:3773/pair#token=abc");
  expect(shareablePairingUrl({ ...base, currentOrigin: "http://localhost:52689" })).toBeNull();
  expect(shareablePairingUrl({ ...base, currentOrigin: "http://10.0.0.9:3773" })).toBe("http://10.0.0.9:3773/pair#token=abc");
  expect(shareablePairingUrl({ ...base, credential: undefined, currentOrigin: "http://10.0.0.9:3773" })).toBeNull();
  expect(isLoopbackHostname("127.0.0.1")).toBe(true);
  expect(isLoopbackHostname("192.168.1.2")).toBe(false);
});

test("terminal:read travels with terminal:operate", () => {
  expect(togglePairingScopeSelection(["terminal:read"], "terminal:operate", true).sort()).toEqual(["terminal:operate", "terminal:read"]);
  expect(togglePairingScopeSelection(["terminal:read", "terminal:operate"], "terminal:read", false)).toEqual([]);
  expect(togglePairingScopeSelection([], "access:write", true)).toEqual(["access:write"]);
  expect(togglePairingScopeSelection(["access:write"], "access:write", false)).toEqual([]);
});

test("without the desktop bridge the Network access row reads the auth policy", () => {
  expect(networkAccessWithoutBridge("remote-reachable")).toEqual({ description: "Remote access is already configured. Change network exposure where the server starts.", showSwitch: true, on: true });
  expect(networkAccessWithoutBridge("loopback-browser").description).toBe("Only this machine can connect. Restart with a non-loopback host for remote pairing.");
  expect(networkAccessWithoutBridge("loopback-browser").on).toBe(false);
  expect(networkAccessWithoutBridge(null)).toEqual({ description: "Network exposure information is unavailable.", showSwitch: false, on: false });
});

test("Tailscale and WSL helpers keep the reference's copy and rules", () => {
  expect(missingTailscaleEndpointDescription({ mode: "local-only", tailscaleServeEnabled: false })).toBe("Turn on Network access to detect Tailscale.");
  expect(missingTailscaleEndpointDescription({ mode: "network-accessible" })).toBe("Start Tailscale to set up HTTPS access through MagicDNS.");
  expect(missingTailscaleEndpointDescription(null)).toBe("Start Tailscale to set up HTTPS access through MagicDNS.");
  expect(resolveTailscaleServeBaseUrl({ httpBaseUrl: "https://box.ts.net" }, 8443, true)).toBe("https://box.ts.net:8443");
  expect(resolveTailscaleServeBaseUrl({ httpBaseUrl: "https://box.ts.net" }, 0, false)).toBe("https://box.ts.net");
  expect(resolveTailscaleServeBaseUrl(null, 443, true)).toBeNull();
  expect(isWslSettingsRowVisible({ state: null, error: null })).toBe(false);
  expect(isWslSettingsRowVisible({ state: null, error: "x" })).toBe(true);
  expect(isWslSettingsRowVisible({ state: { available: false, enabled: false, wslOnly: false }, error: null })).toBe(false);
});

test("the access environment is the explicit one, the primary, or a connected one", () => {
  const environments = [{ environmentId: "a", connected: false }, { environmentId: "b", connected: true }];
  expect(resolveAccessEnvironmentId({ primaryEnvironmentId: "a", environments, selected: "b" })).toBe("b");
  expect(resolveAccessEnvironmentId({ primaryEnvironmentId: "a", environments, selected: "zzz" })).toBe("a");
  expect(resolveAccessEnvironmentId({ primaryEnvironmentId: null, environments, selected: null })).toBe("b");
  expect(resolveAccessEnvironmentId({ primaryEnvironmentId: null, environments: [], selected: null })).toBeNull();
  expect(sessionPermissionsUnavailableMessage({ connected: false, failed: false, rejected: false })).toBe("Connect to this environment to view this session’s permissions.");
  expect(sessionPermissionsUnavailableMessage({ connected: true, failed: true, rejected: false })).toBe("Could not verify your permissions. Retrying automatically.");
});
