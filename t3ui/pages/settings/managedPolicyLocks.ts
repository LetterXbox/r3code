// The administrator's locks the settings pages honour (packages/contracts managedPolicy.ts): a runtime mode above the
// policy's ceiling, a setting the policy pins, a capability it turns off. Pure, over the policy summary the server
// reports in its config snapshot.
type Dict = Record<string, unknown>;
const dict = (value: unknown): Dict | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dict) : null);

export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";
const RANK: Record<RuntimeMode, number> = { "approval-required": 0, "auto-accept-edits": 1, auto: 2, "full-access": 3 };
const LABELS: Record<RuntimeMode, string> = { "approval-required": "Supervised", "auto-accept-edits": "Auto-accept edits", auto: "Auto", "full-access": "Full access" };

/** managedRuntimeModeDenial: why `mode` is unavailable under the policy, or undefined when it is allowed. */
export function managedRuntimeModeDenial(policy: Dict | null, mode: RuntimeMode): string | undefined {
  const organization = policy?.organization;
  const ceiling = dict(policy?.limits)?.maxRuntimeMode as RuntimeMode | undefined;
  if (typeof organization !== "string" || ceiling === undefined || !(ceiling in RANK)) return undefined;
  return RANK[mode] > RANK[ceiling] ? `${organization} limits threads to ${LABELS[ceiling]}.` : undefined;
}

/** The mode a policy lets a thread use: the mode itself, else the broadest allowed one. */
export function clampManagedRuntimeMode(policy: Dict | null, mode: RuntimeMode): RuntimeMode {
  const modes = Object.keys(RANK) as RuntimeMode[];
  return managedRuntimeModeDenial(policy, mode) === undefined ? mode : (modes.filter((candidate) => managedRuntimeModeDenial(policy, candidate) === undefined).pop() ?? mode);
}

/** isManagedSettingPath: the setting is pinned by the policy (`lockedSettings` holds dot paths such as `storageCleanup.logsAfterDays`). */
export function managedSettingLock(policy: Dict | null, path: string): string | undefined {
  const organization = policy?.organization;
  const locked = Array.isArray(policy?.lockedSettings) ? (policy!.lockedSettings as unknown[]) : [];
  if (typeof organization !== "string") return undefined;
  return locked.some((entry) => typeof entry === "string" && (entry === path || path.startsWith(`${entry}.`) || entry.startsWith(`${path}.`))) ? organization : undefined;
}

const CAPABILITY_LABELS = { remoteClients: "connecting from other devices", connect: "T3 Connect", webhookTasks: "webhook tasks", browserCookieImport: "importing browser cookies", previewTunnel: "the preview tunnel" } as const;

/** managedCapabilityDenial: why a capability is unavailable under the policy ("Acme's policy does not allow webhook tasks."). */
export function managedCapabilityDenial(policy: Dict | null, capability: keyof typeof CAPABILITY_LABELS): string | undefined {
  const organization = policy?.organization;
  const limits = dict(policy?.limits);
  if (typeof organization !== "string" || !limits) return undefined;
  const denied = capability === "remoteClients" ? Array.isArray(limits.clients) && !(limits.clients as unknown[]).includes("remote") : limits[capability] === false;
  return denied ? `${organization}'s policy does not allow ${CAPABILITY_LABELS[capability]}.` : undefined;
}
