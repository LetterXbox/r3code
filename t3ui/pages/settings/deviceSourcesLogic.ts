// The logic of DeviceSourcesSettings.tsx and the host editors (deviceHostsSettings.logic.ts,
// easDeviceHostsSettings.logic.ts, simlockDeviceHostsSettings.logic.ts, deviceHostConnectionChecks.ts) for the one
// environment this client is paired with: the configured SSH, EAS and Simlock hosts, what each is doing, and the
// settings patches that add, change and remove them.
type Dict = Record<string, unknown>;

export interface SshHost { kind: "ssh"; id: string; label: string; target: string; identityFile?: string; port?: number }
export interface EasHost { kind: "eas"; id: string; label: string; appId?: string; accessToken: unknown; maxSessionMinutes: number; idleMinutes: number; maxConcurrentSessions: number }
export interface SimlockHost { kind: "simlock"; id: string; label: string; gatewayUrl: string; agentToken: unknown; maxLeases: number; maxLeaseMinutes: number }

const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: unknown): Dict[] => (Array.isArray(value) ? value.filter(isDict) : []);

export const readSshHosts = (settings: Dict | null): SshHost[] => list(settings?.deviceHosts) as unknown as SshHost[];
export const readEasHosts = (settings: Dict | null): EasHost[] => list(settings?.easDeviceHosts) as unknown as EasHost[];
export const readSimlockHosts = (settings: Dict | null): SimlockHost[] => list(settings?.simlockDeviceHosts) as unknown as SimlockHost[];

export const newSshHost = (id: string): SshHost => ({ kind: "ssh", id, label: "", target: "" });
export const newEasHost = (id: string): EasHost => ({ kind: "eas", id, label: "EAS Simulator", accessToken: "", maxSessionMinutes: 30, idleMinutes: 10, maxConcurrentSessions: 2 });
export const newSimlockHost = (id: string): SimlockHost => ({ kind: "simlock", id, label: "Simlock", gatewayUrl: "", agentToken: "", maxLeases: 2, maxLeaseMinutes: 60 });

const sameDestination = (a: SshHost, b: SshHost) => a.target === b.target && a.port === b.port && a.identityFile === b.identityFile;

/** updateDeviceHosts: replace the host it was edited from, else add; remove drops it. */
export function updateSshHosts(hosts: readonly SshHost[], host: SshHost, remove: boolean, original: SshHost = host): SshHost[] {
  const existing = hosts.find((candidate) => candidate.id === original.id) ?? hosts.find((candidate) => sameDestination(candidate, original)) ?? (remove ? undefined : hosts.find((candidate) => sameDestination(candidate, host)));
  if (remove) return hosts.filter((candidate) => candidate.id !== existing?.id);
  return existing ? hosts.map((candidate) => (candidate.id === existing.id ? { ...host, id: existing.id } : candidate)) : [...hosts, host];
}

/** updateEasDeviceHosts: with `keepToken` the saved (redacted) token stays, as a changed token is the only one sent. */
export function updateEasHosts(hosts: readonly EasHost[], host: EasHost, remove: boolean, keepToken = false): EasHost[] {
  if (remove) return hosts.filter((candidate) => candidate.id !== host.id);
  const existing = hosts.find((candidate) => candidate.id === host.id);
  const next = keepToken ? { ...host, accessToken: existing?.accessToken ?? "" } : host;
  return existing ? hosts.map((candidate) => (candidate.id === host.id ? next : candidate)) : [...hosts, next];
}

export function updateSimlockHosts(hosts: readonly SimlockHost[], host: SimlockHost, remove: boolean, keepToken = false): SimlockHost[] {
  if (remove) return hosts.filter((candidate) => candidate.id !== host.id);
  const existing = hosts.find((candidate) => candidate.id === host.id);
  const next = keepToken ? { ...host, agentToken: existing?.agentToken ?? "" } : host;
  return existing ? hosts.map((candidate) => (candidate.id === host.id ? next : candidate)) : [...hosts, next];
}

/** easSessionLimits: the line under an EAS host. */
export function easSessionLimits(host: EasHost): string {
  const sessions = host.maxConcurrentSessions === 1 ? "1 session" : `${host.maxConcurrentSessions} sessions`;
  return `Up to ${sessions} at once, each stopped after ${host.maxSessionMinutes} min or ${host.idleMinutes} idle min`;
}

export function simlockLeaseLimits(host: SimlockHost): string {
  const leases = host.maxLeases === 1 ? "1 lease" : `${host.maxLeases} leases`;
  return `Up to ${leases} at once, each ended after ${host.maxLeaseMinutes} min`;
}

export const simlockDescription = (host: SimlockHost) => `${host.gatewayUrl.replace(/^https?:\/\//, "")} · ${simlockLeaseLimits(host)}`;

/** Why a draft cannot be saved, from the contracts' checks (a target may not start with `-` or contain spaces, and so on). */
export function sshDraftError(host: SshHost): string | null {
  if (!host.label.trim()) return "Enter a name for this machine.";
  if (!/^[^\s-][^\s]*$/.test(host.target.trim())) return "Enter an SSH destination such as user@host. It cannot start with - or contain spaces.";
  if (host.port !== undefined && (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535)) return "The port must be between 1 and 65535.";
  return null;
}

/** EasDeviceHostEditor's `problem`: why Save is off, for the limits the fields' ranges do not show. */
export function easDraftError(host: EasHost): string | null {
  const within = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;
  const valid = host.label.trim().length > 0 && within(host.maxSessionMinutes, 1, 115) && within(host.idleMinutes, 1, 60) && within(host.maxConcurrentSessions, 1, 20) && host.idleMinutes < host.maxSessionMinutes;
  if (valid) return null;
  return host.maxSessionMinutes > 0 && host.idleMinutes >= host.maxSessionMinutes ? "Idle minutes must be smaller than session minutes." : "Give the host a label and limits within the ranges shown.";
}

/** simlockDeviceHostProblem: the label first, then a gateway that is not an origin, then the limits. */
export function simlockDraftError(host: SimlockHost): string | null {
  const within = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;
  const origin = /^https?:\/\/[^\s/]+\/?$/.test(host.gatewayUrl.trim());
  if (host.label.trim() && origin && within(host.maxLeases, 1, 20) && within(host.maxLeaseMinutes, 5, 240)) return null;
  if (!host.label.trim()) return "Give the host a label.";
  return !origin ? "Enter the gateway's origin, such as https://gateway.example.ts.net:4700." : "Keep the limits within the ranges shown.";
}

/** The SSH draft as the contract decodes it: an empty identity file is dropped, the rest trimmed. */
export function cleanSshHost(host: SshHost): SshHost {
  const { identityFile, port, ...rest } = host;
  return { ...rest, label: host.label.trim(), target: host.target.trim(), ...(identityFile?.trim() ? { identityFile: identityFile.trim() } : {}), ...(port !== undefined ? { port } : {}) };
}

export interface HostStatus { tone: "pending" | "warning" | "error"; label: string; detail?: string }

/** hostStatus: what a configured host is doing, when it is not simply working. */
export function hostStatus(state: Dict | null, hostId: string): HostStatus | undefined {
  if (!state) return { tone: "pending", label: "Loading" };
  const status = (isDict(state.hostStatuses) ? state.hostStatuses[hostId] : undefined) as Dict | undefined;
  const detail = typeof status?.detail === "string" ? status.detail : undefined;
  switch (status?.status) {
    case "ready": {
      // incompleteListings (DeviceSetup.tsx): platforms whose latest listing may miss devices.
      const flagged = Array.isArray(status.incompletePlatforms) ? (status.incompletePlatforms as unknown[]) : [];
      const incomplete = (["ios", "android"] as const).filter((platform) => flagged.includes(platform) || (platform === "android" && status.androidDiscoveryIncomplete === true));
      if (incomplete.length === 0) return undefined;
      const name = incomplete.length > 1 ? "Device" : incomplete[0] === "ios" ? "iOS" : "Android";
      return { tone: "warning", label: `${name} list may be incomplete`, ...(detail ? { detail } : {}) };
    }
    case "installing":
    case "starting":
      return { tone: "pending", label: "Starting", ...(detail ? { detail } : {}) };
    case "failed":
      return { tone: "error", label: "Failed", ...(detail ? { detail } : {}) };
    default:
      return undefined;
  }
}

export interface Platform { platform: "ios" | "android"; available: boolean; reason?: string }

/** The platforms a configured host offers, once the hub has reached it. */
export function hostPlatforms(state: Dict | null, hostId: string): Platform[] | undefined {
  const host = list(state?.hosts).find((entry) => entry.id === hostId);
  return host ? (list(host.platforms) as unknown as Platform[]) : undefined;
}

export interface EasAccount { signedInAs: string; credentialSource: "settings" | "env" | "eas-login"; apps: { id: string; fullName: string }[] }
const CREDENTIAL_SOURCES: Record<EasAccount["credentialSource"], string> = { settings: "the access token saved here", env: "EXPO_TOKEN on the server", "eas-login": "the server's eas login" };

export function readEasAccount(value: unknown): EasAccount | null {
  const item = isDict(value) ? value : null;
  if (!item || typeof item.signedInAs !== "string" || !(item.credentialSource === "settings" || item.credentialSource === "env" || item.credentialSource === "eas-login")) return null;
  const apps = Array.isArray(item.apps) ? item.apps.flatMap((entry) => (isDict(entry) && typeof entry.id === "string" && typeof entry.fullName === "string" ? [{ id: entry.id, fullName: entry.fullName }] : [])) : [];
  return { signedInAs: item.signedInAs, credentialSource: item.credentialSource, apps };
}

export const easAccountMessage = (account: EasAccount) => `Signed in as ${account.signedInAs} with ${CREDENTIAL_SOURCES[account.credentialSource]}.`;

/** What the account check sends: a token typed here, else the saved host's own token. */
export function easAccountInput(host: Pick<EasHost, "id" | "accessToken">, typedToken: string, isNew: boolean): Dict {
  if (typedToken.trim() !== "") return { accessToken: typedToken.trim() };
  return isNew ? {} : { hostId: host.id };
}

export interface SimlockIdentity { gatewayUrl: string; signedInAs: string; tokenSource: "entered" | "settings" | "env" }

export function readSimlockIdentity(value: unknown): SimlockIdentity | null {
  const item = isDict(value) ? value : null;
  if (!item || typeof item.gatewayUrl !== "string" || typeof item.signedInAs !== "string" || !(item.tokenSource === "entered" || item.tokenSource === "settings" || item.tokenSource === "env")) return null;
  return { gatewayUrl: item.gatewayUrl, signedInAs: item.signedInAs, tokenSource: item.tokenSource };
}

export const simlockIdentityMessage = (identity: SimlockIdentity) => (identity.tokenSource === "env" ? `Using this machine's agent-device token (${identity.signedInAs}).` : `Accepted as ${identity.signedInAs}.`);

export function simlockIdentityInput(host: Pick<SimlockHost, "id" | "gatewayUrl">, typedToken: string, isNew: boolean): Dict {
  return { gatewayUrl: host.gatewayUrl.trim(), ...(typedToken.trim() !== "" ? { agentToken: typedToken.trim() } : isNew ? {} : { hostId: host.id }) };
}
