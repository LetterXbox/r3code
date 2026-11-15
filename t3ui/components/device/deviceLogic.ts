// The rules of the Device surface (components/device/DevicePanel.tsx, DeviceSetup.tsx, DeviceHostUpdates.tsx) over the
// `subscribeDeviceState` payload (packages/contracts/src/device.ts). Pure, so they are tested without an engine.

export type DevicePlatform = "ios" | "android";
export type DeviceHostKind = "local" | "ssh" | "eas" | "simlock";
export type DeviceHostStatus = "disabled" | "idle" | "installing" | "starting" | "ready" | "failed";

export interface DeviceHostSummary {
  id: string;
  label: string;
  kind: DeviceHostKind;
  platforms: { platform: DevicePlatform; available: boolean; reason?: string }[];
  hubInstalled: boolean;
  agentDeviceInstalled: boolean;
  toolInspectionError?: string;
  tools?: unknown;
}

export interface DeviceSummary { hostId: string; id: string; platform: DevicePlatform; name: string; version: string; booted: boolean; physical: boolean }
export interface DeviceSession { threadId: string; hostId: string; deviceId: string; platform: DevicePlatform; openedAt: string }
export interface HostStatusEntry { status: DeviceHostStatus; detail?: string; androidDiscoveryIncomplete?: boolean; incompletePlatforms?: DevicePlatform[] }

export interface DeviceServiceState {
  hosts: DeviceHostSummary[];
  hostStatus: DeviceHostStatus;
  hostStatusDetail?: string;
  hostStatuses: Record<string, HostStatusEntry>;
  devices: DeviceSummary[];
  sessions: DeviceSession[];
  bootingDevices: (DeviceSummary & { threadId: string })[];
  onboardingCompleted: boolean;
  agentAccessEnabled: boolean;
  supportsHostRetry: boolean;
  supportsToolUpdate: boolean;
  supportsToolInspection: boolean;
  hubBasePath: string;
  revision: number;
}

/** EMPTY_DEVICE_STATE (state/device.ts): what the panel shows before the first snapshot. */
export const EMPTY_DEVICE_STATE: DeviceServiceState = {
  hosts: [], hostStatus: "disabled", hostStatuses: {}, devices: [], sessions: [], bootingDevices: [],
  onboardingCompleted: false, agentAccessEnabled: false, supportsHostRetry: false, supportsToolUpdate: false, supportsToolInspection: false,
  hubBasePath: "/api/device-hub", revision: 0,
};

type Dict = Record<string, unknown>;
const record = (value: unknown): Dict | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dict) : null);
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const platformOf = (value: unknown): DevicePlatform | null => (value === "ios" || value === "android" ? value : null);
const STATUSES: readonly string[] = ["disabled", "idle", "installing", "starting", "ready", "failed"];
const statusOf = (value: unknown, fallback: DeviceHostStatus): DeviceHostStatus => (typeof value === "string" && STATUSES.includes(value) ? (value as DeviceHostStatus) : fallback);

function readHost(value: unknown): DeviceHostSummary | null {
  const host = record(value);
  if (!host || typeof host.id !== "string" || typeof host.label !== "string") return null;
  const kind: DeviceHostKind = host.kind === "ssh" || host.kind === "eas" || host.kind === "simlock" ? host.kind : "local";
  const platforms = (Array.isArray(host.platforms) ? host.platforms : []).flatMap((item) => {
    const entry = record(item);
    const platform = platformOf(entry?.platform);
    return entry && platform ? [{ platform, available: entry.available === true, ...(text(entry.reason) !== undefined ? { reason: text(entry.reason)! } : {}) }] : [];
  });
  return {
    id: host.id, label: host.label, kind, platforms, hubInstalled: host.hubInstalled === true, agentDeviceInstalled: host.agentDeviceInstalled === true,
    ...(text(host.toolInspectionError) !== undefined ? { toolInspectionError: text(host.toolInspectionError)! } : {}),
    ...(host.tools !== undefined ? { tools: host.tools } : {}),
  };
}

function readDevice(value: unknown): DeviceSummary | null {
  const device = record(value);
  const platform = platformOf(device?.platform);
  if (!device || !platform || typeof device.hostId !== "string" || typeof device.id !== "string" || typeof device.name !== "string") return null;
  return { hostId: device.hostId, id: device.id, platform, name: device.name, version: text(device.version) ?? "", booted: device.booted === true, physical: device.physical === true };
}

/**
 * The wire payload of `subscribeDeviceState` as the panel reads it. The server sends EAS and Simlock hosts as `easHosts` and
 * `simlockHosts` so older clients do not reject the snapshot; decoded, every host is in `hosts` (DeviceServiceState's transform).
 */
export function readDeviceState(value: unknown): DeviceServiceState | null {
  const wire = record(value);
  if (!wire || typeof wire.hostStatus !== "string") return null;
  const lists = [wire.hosts, wire.easHosts, wire.simlockHosts].flatMap((list) => (Array.isArray(list) ? list : []));
  const statuses: Record<string, HostStatusEntry> = {};
  for (const [id, raw] of Object.entries(record(wire.hostStatuses) ?? {})) {
    const entry = record(raw);
    if (!entry) continue;
    statuses[id] = {
      status: statusOf(entry.status, "idle"),
      ...(text(entry.detail) !== undefined ? { detail: text(entry.detail)! } : {}),
      ...(typeof entry.androidDiscoveryIncomplete === "boolean" ? { androidDiscoveryIncomplete: entry.androidDiscoveryIncomplete } : {}),
      ...(Array.isArray(entry.incompletePlatforms) ? { incompletePlatforms: entry.incompletePlatforms.flatMap((item) => platformOf(item) ?? []) } : {}),
    };
  }
  return {
    hosts: lists.flatMap((item) => readHost(item) ?? []),
    hostStatus: statusOf(wire.hostStatus, "disabled"),
    ...(text(wire.hostStatusDetail) !== undefined ? { hostStatusDetail: text(wire.hostStatusDetail)! } : {}),
    hostStatuses: statuses,
    devices: (Array.isArray(wire.devices) ? wire.devices : []).flatMap((item) => readDevice(item) ?? []),
    sessions: (Array.isArray(wire.sessions) ? wire.sessions : []).flatMap((item): DeviceSession[] => {
      const session = record(item);
      const platform = platformOf(session?.platform);
      return session && platform && typeof session.threadId === "string" && typeof session.hostId === "string" && typeof session.deviceId === "string"
        ? [{ threadId: session.threadId, hostId: session.hostId, deviceId: session.deviceId, platform, openedAt: text(session.openedAt) ?? "" }]
        : [];
    }),
    bootingDevices: (Array.isArray(wire.bootingDevices) ? wire.bootingDevices : []).flatMap((item) => {
      const device = readDevice(item);
      const threadId = text(record(item)?.threadId);
      return device && threadId ? [{ ...device, threadId }] : [];
    }),
    onboardingCompleted: wire.onboardingCompleted === true,
    agentAccessEnabled: wire.agentAccessEnabled === true,
    supportsHostRetry: wire.supportsHostRetry === true,
    supportsToolUpdate: wire.supportsToolUpdate === true,
    supportsToolInspection: wire.supportsToolInspection === true,
    hubBasePath: text(wire.hubBasePath) ?? EMPTY_DEVICE_STATE.hubBasePath,
    revision: typeof wire.revision === "number" ? wire.revision : 0,
  };
}

export const platformName = (platform: DevicePlatform) => (platform === "ios" ? "iOS" : "Android");
/** platformLabel (DevicePanel.tsx). */
export const platformGroupLabel = (platform: DevicePlatform) => (platform === "ios" ? "iOS Simulators" : "Android Emulators");
export const deviceKey = (device: Pick<DeviceSummary, "hostId" | "id">) => `${device.hostId}\u0000${device.id}`;

/** Platforms whose latest listing on a ready host may be missing devices. */
export function incompleteListings(status: HostStatusEntry | undefined): DevicePlatform[] {
  return (["ios", "android"] as const).filter((platform) => status?.status === "ready" && (status.incompletePlatforms?.includes(platform) || (platform === "android" && status.androidDiscoveryIncomplete === true)));
}

export const isAndroidDiscoveryUncertain = (state: DeviceServiceState) => Object.values(state.hostStatuses).some((status) => incompleteListings(status).includes("android"));

/** `hostStatus` only tracks this machine: a machine without simulator tooling never starts its own hub, so remote hosts count too. */
export function deviceHubReadiness(state: DeviceServiceState): { ready: boolean; busy: boolean } {
  const statuses = Object.values(state.hostStatuses).map((host) => host.status);
  const ready = state.hostStatus === "ready" || statuses.includes("ready");
  const busy = !ready && [state.hostStatus, ...statuses].some((status) => status === "installing" || status === "starting");
  return { ready, busy };
}

/** groupDevices: iOS then Android, running devices first, then by name. */
export function groupDevices(state: Pick<DeviceServiceState, "devices">): { platform: DevicePlatform; devices: DeviceSummary[] }[] {
  const groups: { platform: DevicePlatform; devices: DeviceSummary[] }[] = [];
  for (const platform of ["ios", "android"] as const) {
    const devices = state.devices.filter((device) => device.platform === platform).sort((a, b) => Number(b.booted) - Number(a.booted) || a.name.localeCompare(b.name));
    if (devices.length > 0) groups.push({ platform, devices });
  }
  return groups;
}

/** The discovery warnings of ready hosts (DevicePanel's `diagnostics`). */
export function hostDiagnostics(state: DeviceServiceState): { hostId: string; label: string; detail: string; incompletePlatforms: DevicePlatform[] }[] {
  return state.hosts.flatMap((host) => {
    const status = state.hostStatuses[host.id];
    const detail = status?.detail ?? (host.kind === "local" ? state.hostStatusDetail : undefined);
    return detail && (status?.status ?? state.hostStatus) === "ready" ? [{ hostId: host.id, label: host.label, detail, incompletePlatforms: incompleteListings(status) }] : [];
  });
}

/** The line a warning gives (DeviceDiscoveryWarning). */
export function discoveryWarningText(label: string, platforms: readonly DevicePlatform[]): string {
  const names = platforms.map(platformName);
  return names.length > 0 ? `${names.join(" and ")} ${names.length > 1 ? "lists" : "list"} on ${label} may be incomplete.` : `Device discovery on ${label} reported a warning.`;
}

export function platformSetupStatus(state: DeviceServiceState, platform: DevicePlatform): { ready: boolean; message: string } {
  const hasDevices = state.devices.some((device) => device.platform === platform);
  if (platform === "android" && !hasDevices && isAndroidDiscoveryUncertain(state)) {
    return { ready: false, message: "The Android device list may be incomplete. Check the device host and try again." };
  }
  const availabilities = state.hosts.flatMap((host) => host.platforms.filter((candidate) => candidate.platform === platform).map((candidate) => ({ ...candidate, host })));
  const supportingHosts = availabilities.filter((candidate) => candidate.available).map((candidate) => candidate.host);
  if (supportingHosts.length === 0) return { ready: false, message: availabilities[0]?.reason ?? `${platformName(platform)} support was not detected.` };
  const readyHosts = supportingHosts.filter((host) => state.hostStatuses[host.id]?.status === "ready" || (host.kind === "local" && state.hostStatus === "ready"));
  if (readyHosts.length > 0 && !hasDevices) {
    if (readyHosts.some((host) => state.hostStatuses[host.id]?.incompletePlatforms?.includes(platform))) {
      return { ready: false, message: `No ${platformName(platform)} devices were listed because device discovery reported a problem.` };
    }
    return {
      ready: false,
      message: platform === "ios"
        ? "Xcode is installed, but no iOS Simulator is available. Install a runtime in Xcode Settings → Components."
        : "The Android SDK is installed, but no virtual device exists. Create one in Android Studio → Device Manager.",
    };
  }
  const remoteHost = supportingHosts.every((host) => host.kind !== "local") ? supportingHosts[0] : undefined;
  const location = remoteHost ? ` on ${remoteHost.label}` : "";
  return {
    ready: true,
    message: remoteHost?.kind === "eas"
      ? `${remoteHost.label} starts ${platform === "ios" ? "iOS Simulators" : "Android emulators"} in the cloud with EAS Simulator.`
      : platform === "ios" ? `Xcode and iOS Simulator are available${location}.` : `The Android SDK and Emulator are available${location}.`,
  };
}

/** The device panel needs setup: the first snapshot is in and onboarding is incomplete or the hub is off (DevicePanel's gate). */
export function needsSetup(state: DeviceServiceState, loaded: boolean): boolean {
  return loaded && (!state.onboardingCompleted || state.hostStatus === "disabled");
}

/** What the loading view says while a device opens or devices are found (DevicePanel). */
export function loadingMessage(input: { loadError: string | null; pending: DeviceSummary | null; hostStatus: DeviceHostStatus; hostStatusDetail?: string }): string {
  if (input.loadError) return input.loadError;
  if (input.pending) return input.pending.booted ? "Opening device…" : "Starting device…";
  if (input.hostStatus === "installing") return input.hostStatusDetail ?? "Installing device support…";
  return "Finding devices…";
}

/** The empty list's line (DevicePanel). */
export function emptyListMessage(state: Pick<DeviceServiceState, "hostStatus" | "hostStatusDetail">): string {
  return state.hostStatus === "failed" ? (state.hostStatusDetail ?? "The device hub failed to start.") : "No simulators or emulators were found on this environment.";
}

/** Whether the "No Android virtual devices found." hint shows (DevicePanel). */
export function showsAndroidHint(state: DeviceServiceState): boolean {
  const { ready } = deviceHubReadiness(state);
  const unavailable = state.hosts.some((host) => host.platforms.some((platform) => !platform.available && platform.platform === "android"));
  return ready && !isAndroidDiscoveryUncertain(state) && !state.devices.some((device) => device.platform === "android") && !unavailable;
}

/** The line a host's installing, starting or failed status gives (DeviceHostUpdates). */
export function hostUpdateDetail(status: HostStatusEntry): string {
  return status.detail ?? (status.status === "failed" ? "Device support could not start." : status.status === "installing" ? "Installing device tools…" : "Starting device tools…");
}
