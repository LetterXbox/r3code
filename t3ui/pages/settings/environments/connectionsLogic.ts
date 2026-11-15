// The pure rules of the Connections / Sharing & access pages, ported from
// components/settings/ConnectionsSettings.logic.ts, pairingUrls.ts and hostedPairing.ts
// (and the `AdvertisedEndpoint` contract, packages/contracts/src/remoteAccess.ts).
// Nothing here reads a window, a store or a signal.

export type AdvertisedEndpointReachability = "loopback" | "lan" | "private-network" | "public";
export type AdvertisedEndpointStatus = "available" | "unavailable" | "unknown";

/** The fields of an `AdvertisedEndpoint` the pages read. */
export interface AdvertisedEndpoint {
  id: string;
  label: string;
  provider: { id: string; label?: string };
  httpBaseUrl: string;
  wsBaseUrl?: string;
  reachability: AdvertisedEndpointReachability;
  compatibility: { hostedHttpsApp: string; desktopApp?: string };
  status: AdvertisedEndpointStatus | string;
  isDefault?: boolean;
  description?: string;
}

/** DEFAULT_HOSTED_APP_URL (packages/shared/src/connectAuth.ts). */
export const DEFAULT_HOSTED_APP_URL = "https://app.t3.codes";

const PAIRING_TOKEN_PARAM = "token";

/** setPairingTokenOnUrl (packages/shared/src/remote.ts): the credential rides in the hash, never the query. */
export function setPairingTokenOnUrl(url: URL, credential: string): URL {
  const next = new URL(url.toString());
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  next.hash = new URLSearchParams([[PAIRING_TOKEN_PARAM, credential]]).toString();
  return next;
}

export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}

/** buildHostedPairingUrl (hostedPairing.ts): the hosted app's /pair link for a host and token. */
export function buildHostedPairingUrl(input: { host: string; token: string; label?: string | null }): string {
  const url = new URL("/pair", DEFAULT_HOSTED_APP_URL);
  url.searchParams.set("host", input.host);
  const label = input.label?.trim();
  if (label) url.searchParams.set("label", label);
  return setPairingTokenOnUrl(url, input.token).toString();
}

/** The hosted app only reaches an https backend. */
export function resolveHostedPairingUrl(endpointUrl: string, credential: string): string | null {
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:") return null;
  return buildHostedPairingUrl({ host: endpointUrl, token: credential });
}

/** resolveCurrentOriginPairingUrl, for the environment the app itself is connected to (its "origin"). */
export function resolveCurrentOriginPairingUrl(origin: string, credential: string): string {
  const url = new URL("/pair", origin);
  return setPairingTokenOnUrl(url, credential).toString();
}

export function isHostedAppPairingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.pathname === "/pair" && url.searchParams.has("host");
  } catch {
    return false;
  }
}

/** isLoopbackHostname (environments/primary). */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || host === "0.0.0.0" || /^127\./.test(host) || host.endsWith(".localhost");
}

export function isTailscaleHttpsEndpoint(endpoint: Pick<AdvertisedEndpoint, "id">): boolean {
  return endpoint.id.startsWith("tailscale-magicdns:");
}

export function endpointDefaultPreferenceKey(endpoint: AdvertisedEndpoint): string {
  if (endpoint.id.startsWith("desktop-loopback:")) return "desktop-core:loopback:http";
  if (endpoint.id.startsWith("desktop-lan:")) return "desktop-core:lan:http";
  if (endpoint.id.startsWith("tailscale-ip:")) return "tailscale:ip:http";
  if (isTailscaleHttpsEndpoint(endpoint)) return "tailscale:magicdns:https";
  let scheme = "unknown";
  try {
    scheme = new URL(endpoint.httpBaseUrl).protocol.replace(/:$/u, "");
  } catch { /* keep "unknown" */ }
  return `${endpoint.provider.id}:${endpoint.reachability}:${scheme}:${endpoint.label}`;
}

export function selectPairingEndpoint(endpoints: readonly AdvertisedEndpoint[], defaultEndpointKey?: string | null): AdvertisedEndpoint | null {
  const available = endpoints.filter((endpoint) => endpoint.status !== "unavailable");
  if (defaultEndpointKey) {
    const chosen = available.find((endpoint) => endpointDefaultPreferenceKey(endpoint) === defaultEndpointKey);
    if (chosen) return chosen;
  }
  return (
    available.find((endpoint) => endpoint.isDefault) ??
    available.find((endpoint) => endpoint.reachability !== "loopback") ??
    available.find((endpoint) => endpoint.compatibility.hostedHttpsApp === "compatible") ??
    null
  );
}

export function resolveAdvertisedEndpointPairingUrl(endpoint: AdvertisedEndpoint, credential: string): string {
  if (endpoint.compatibility.hostedHttpsApp === "compatible") {
    return resolveHostedPairingUrl(endpoint.httpBaseUrl, credential) ?? resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential);
  }
  return resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential);
}

/** Never offer loopback URLs as QR targets; scanning devices would connect to themselves. */
export function isQrShareableEndpoint(endpoint: Pick<AdvertisedEndpoint, "status" | "reachability">): boolean {
  return endpoint.status !== "unavailable" && endpoint.reachability !== "loopback";
}

export function endpointShareHint(endpoint: Pick<AdvertisedEndpoint, "reachability">, url: string): string {
  if (isHostedAppPairingUrl(url)) return "Opens the hosted app, no install needed";
  switch (endpoint.reachability) {
    case "lan": return "Devices on the same network";
    case "private-network": return "Devices on your private network";
    case "public": return "Reachable from anywhere";
    case "loopback": return "Clients on this machine";
  }
}

export interface QrEndpointOption { id: string; preferenceKey: string; qrShareable: boolean }

export function selectQrEndpointOption<T extends QrEndpointOption>(options: readonly T[], selectedId: string | null, defaultPreferenceKey: string | null): T | null {
  return (
    (selectedId !== null ? options.find((option) => option.id === selectedId) : undefined) ??
    (defaultPreferenceKey !== null ? options.find((option) => option.preferenceKey === defaultPreferenceKey) : undefined) ??
    options.find((option) => option.qrShareable) ??
    options[0] ??
    null
  );
}

/** One row of the pairing link's "Reach this machine via" list (PairingLinkListRow's endpointCopyOptions). */
export interface EndpointCopyOption extends QrEndpointOption { label: string; url: string; detail: string }

export function endpointCopyOptions(endpoints: readonly AdvertisedEndpoint[], credential: string | undefined): EndpointCopyOption[] {
  if (!credential) return [];
  const options: EndpointCopyOption[] = [];
  for (const endpoint of endpoints) {
    if (endpoint.status === "unavailable") continue;
    const url = resolveAdvertisedEndpointPairingUrl(endpoint, credential);
    options.push({ id: endpoint.id, preferenceKey: endpointDefaultPreferenceKey(endpoint), label: endpoint.label, url, detail: endpointShareHint(endpoint, url), qrShareable: isQrShareableEndpoint(endpoint) });
  }
  return options;
}

/**
 * The link a pairing row shares (PairingLinkListRow's `shareablePairingUrl`): the chosen endpoint's, else the
 * endpoint URL (hosted first), else this app's own origin when the environment is not on a loopback address.
 */
export function shareablePairingUrl(input: {
  credential: string | undefined;
  endpoints: readonly AdvertisedEndpoint[];
  defaultEndpointKey: string | null;
  endpointUrl: string | null | undefined;
  /** The connected environment's origin when this app is served by it, else null. */
  currentOrigin: string | null;
}): string | null {
  const { credential } = input;
  const endpoint = selectPairingEndpoint(input.endpoints, input.defaultEndpointKey);
  const endpointPairingUrl = endpoint && credential ? resolveAdvertisedEndpointPairingUrl(endpoint, credential) : null;
  if (endpointPairingUrl !== null) return endpointPairingUrl;
  if (credential && input.endpointUrl != null && input.endpointUrl !== "") {
    return resolveHostedPairingUrl(input.endpointUrl, credential) ?? resolveDesktopPairingUrl(input.endpointUrl, credential);
  }
  if (!credential || input.currentOrigin === null) return null;
  try {
    return isLoopbackHostname(new URL(input.currentOrigin).hostname) ? null : resolveCurrentOriginPairingUrl(input.currentOrigin, credential);
  } catch {
    return null;
  }
}

/** Keep terminal:read with terminal:operate to avoid creating unseen shells on every script run. */
export function togglePairingScopeSelection(current: readonly string[], scope: string, checked: boolean): string[] {
  const without = (scopes: readonly string[]) => scopes.filter((item) => item !== scope);
  if (!checked) return scope === "terminal:read" ? without(current).filter((item) => item !== "terminal:operate") : without(current);
  const next = [...without(current), scope];
  return scope === "terminal:operate" && !next.includes("terminal:read") ? [...next, "terminal:read"] : next;
}

/** The "Read only" preset of the Create pairing link dialog. */
export const READ_ONLY_PAIRING_SCOPES = ["orchestration:read", "filesystem:read", "diagnostics:read", "terminal:read"] as const;

/** AuthStandardClientScopes (packages/contracts/src/auth.ts), in its order. */
export const STANDARD_PAIRING_SCOPES = [
  "orchestration:read", "orchestration:operate", "settings:write", "providers:manage", "environment:maintain", "preview:operate",
  "diagnostics:read", "terminal:read", "terminal:operate", "source-control:write", "filesystem:read", "filesystem:write",
  "relay:read", "access:read", "access:write", "relay:write",
] as const;

/** missingTailscaleEndpointDescription. */
export function missingTailscaleEndpointDescription(state: { mode: string; tailscaleServeEnabled?: boolean } | null): string {
  return state && state.mode !== "network-accessible" && !state.tailscaleServeEnabled
    ? "Turn on Network access to detect Tailscale."
    : "Start Tailscale to set up HTTPS access through MagicDNS.";
}

export function resolveTailscaleServeBaseUrl(endpoint: Pick<AdvertisedEndpoint, "httpBaseUrl"> | null, port: number, isPortValid: boolean): string | null {
  if (!endpoint) return null;
  if (!isPortValid) return endpoint.httpBaseUrl;
  try {
    const url = new URL(endpoint.httpBaseUrl);
    url.port = String(port);
    return url.toString().replace(/\/$/u, "");
  } catch {
    return endpoint.httpBaseUrl;
  }
}

export interface DesktopWslStateShape { available: boolean; enabled: boolean; wslOnly: boolean }

export function isWslSettingsRowVisible(input: { state: DesktopWslStateShape | null; error: string | null }): boolean {
  const { state, error } = input;
  return state ? state.available || state.enabled || state.wslOnly : error !== null;
}

/**
 * The Network access row of a client without the desktop bridge (renderDisabledNetworkAccessRow): the
 * description follows the session's auth policy, and the switch (only drawn for the two known policies)
 * is disabled with a tooltip. Exposure is changed where the server process is launched.
 */
export function networkAccessWithoutBridge(policy: string | null): { description: string; showSwitch: boolean; on: boolean } {
  return {
    description:
      policy === "remote-reachable"
        ? "Remote access is already configured. Change network exposure where the server starts."
        : policy === "loopback-browser"
          ? "Only this machine can connect. Restart with a non-loopback host for remote pairing."
          : "Network exposure information is unavailable.",
    showSwitch: policy === "remote-reachable" || policy === "loopback-browser",
    on: policy === "remote-reachable",
  };
}

export const NETWORK_ACCESS_TOOLTIP = "Network exposure changes restart the backend and must be controlled where the server process is launched.";

const accessTimestampFormat = (parsed: Date): string => {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed);
  } catch {
    return parsed.toISOString();
  }
};

export function formatAccessTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : accessTimestampFormat(parsed);
}

/** resolveAccessEnvironmentId: an explicit choice while it is listed, else the primary, else a connected environment. */
export function resolveAccessEnvironmentId(input: {
  primaryEnvironmentId: string | null;
  environments: readonly { environmentId: string; connected: boolean }[];
  selected: string | null;
}): string | null {
  const isListed = (id: string | null) => input.environments.some((environment) => environment.environmentId === id);
  if (isListed(input.selected)) return input.selected;
  if (isListed(input.primaryEnvironmentId)) return input.primaryEnvironmentId;
  return (input.environments.find((environment) => environment.connected) ?? input.environments[0])?.environmentId ?? null;
}

/** sessionPermissionsUnavailableMessage (packages/shared/src/authScopeOptions.ts). */
export function sessionPermissionsUnavailableMessage(input: { connected: boolean; failed: boolean; rejected: boolean }): string {
  if (!input.connected) return "Connect to this environment to view this session’s permissions.";
  if (input.rejected) return "This environment did not accept your session. Reconnect to try again.";
  return input.failed ? "Could not verify your permissions. Retrying automatically." : "Checking permissions…";
}
