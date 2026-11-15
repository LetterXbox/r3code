// The background activity policy (packages/shared/src/backgroundActivitySettings.ts and the helpers of
// SettingsPanels.logic.ts): a shared profile plus optional overrides, kept in the server's `backgroundActivity`
// as `{ schemaVersion: 1, profile, baseProfile?, overrides }`, with intervals in milliseconds on the wire.
type Dict = Record<string, unknown>;

export type Profile = "balanced" | "performance" | "battery-saver";
export type ProfileOption = Profile | "advanced";

export interface Resolved {
  profile: Profile;
  automaticGitFetchInterval: number;
  providerHealthRefreshInterval: number;
  hostPowerMonitorActiveInterval: number;
  hostPowerMonitorIdleInterval: number;
  pauseWhenHostLocked: boolean;
  pauseWhenHostLowPower: boolean;
  pauseWhenClientLowPower: boolean;
  pauseWhenOnBattery: boolean;
}

const seconds = (n: number) => n * 1000;
const minutes = (n: number) => n * 60_000;

export const PRESETS: Record<Profile, Resolved> = {
  performance: { profile: "performance", automaticGitFetchInterval: seconds(15), providerHealthRefreshInterval: minutes(1), hostPowerMonitorActiveInterval: seconds(30), hostPowerMonitorIdleInterval: minutes(2), pauseWhenHostLocked: true, pauseWhenHostLowPower: false, pauseWhenClientLowPower: false, pauseWhenOnBattery: false },
  balanced: { profile: "balanced", automaticGitFetchInterval: seconds(30), providerHealthRefreshInterval: minutes(5), hostPowerMonitorActiveInterval: seconds(30), hostPowerMonitorIdleInterval: minutes(5), pauseWhenHostLocked: true, pauseWhenHostLowPower: true, pauseWhenClientLowPower: true, pauseWhenOnBattery: false },
  "battery-saver": { profile: "battery-saver", automaticGitFetchInterval: 0, providerHealthRefreshInterval: minutes(15), hostPowerMonitorActiveInterval: minutes(1), hostPowerMonitorIdleInterval: minutes(10), pauseWhenHostLocked: true, pauseWhenHostLowPower: true, pauseWhenClientLowPower: true, pauseWhenOnBattery: true },
};

export const PROFILE_LABELS: Record<ProfileOption, string> = { balanced: "Balanced", performance: "Performance", "battery-saver": "Battery saver", advanced: "Advanced" };
export const PROFILE_DESCRIPTIONS: Record<Profile, string> = {
  balanced: "Pauses probes for idle clients, locked hosts, or low power mode.",
  performance: "Allows scoped background probes while any subscribed client remains connected.",
  "battery-saver": "Also pauses background probes when the host or client is on battery.",
};
export const ADVANCED_DESCRIPTION = "Uses custom intervals.";
export const PROVIDER_HEALTH_INTERVAL_STEP_SECONDS = 30;

export const BOOLEAN_OVERRIDES = [
  { key: "pauseWhenHostLocked", label: "Pause when host is locked" },
  { key: "pauseWhenHostLowPower", label: "Pause on host low power" },
  { key: "pauseWhenClientLowPower", label: "Pause on client low power" },
  { key: "pauseWhenOnBattery", label: "Pause on battery" },
] as const;

const isProfile = (value: unknown): value is Profile => value === "balanced" || value === "performance" || value === "battery-saver";
const dict = (value: unknown): Dict => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dict) : {});

export interface BackgroundActivity { schemaVersion: 1; profile: Profile | "custom"; baseProfile?: Profile; overrides: Dict }

/** The server's value with every field defaulted, as the schema decodes it (the legacy `backgroundActivityProfile` seeds an unset policy). */
export function readBackgroundActivity(settings: Dict | null): BackgroundActivity {
  const value = dict(settings?.backgroundActivity);
  const legacy = isProfile(settings?.backgroundActivityProfile) ? (settings!.backgroundActivityProfile as Profile) : "balanced";
  const profile = value.profile === "custom" || isProfile(value.profile) ? (value.profile as Profile | "custom") : legacy;
  return { schemaVersion: 1, profile, ...(isProfile(value.baseProfile) ? { baseProfile: value.baseProfile } : {}), overrides: dict(value.overrides) };
}

export const baseProfile = (policy: BackgroundActivity): Profile => (policy.profile === "custom" ? (policy.baseProfile ?? "balanced") : policy.profile);

export function resolveBackgroundActivity(settings: Dict | null): Resolved {
  const policy = readBackgroundActivity(settings);
  const base = baseProfile(policy);
  const preset = PRESETS[base];
  const overrides = policy.profile === "custom" ? policy.overrides : {};
  const number = (key: keyof Resolved) => (typeof overrides[key] === "number" ? (overrides[key] as number) : (preset[key] as number));
  const flag = (key: keyof Resolved) => (typeof overrides[key] === "boolean" ? (overrides[key] as boolean) : (preset[key] as boolean));
  return {
    profile: base,
    automaticGitFetchInterval: number("automaticGitFetchInterval"),
    providerHealthRefreshInterval: number("providerHealthRefreshInterval"),
    hostPowerMonitorActiveInterval: number("hostPowerMonitorActiveInterval"),
    hostPowerMonitorIdleInterval: number("hostPowerMonitorIdleInterval"),
    pauseWhenHostLocked: flag("pauseWhenHostLocked"),
    pauseWhenHostLowPower: flag("pauseWhenHostLowPower"),
    pauseWhenClientLowPower: flag("pauseWhenClientLowPower"),
    pauseWhenOnBattery: flag("pauseWhenOnBattery"),
  };
}

const KEYS: (keyof Resolved)[] = ["automaticGitFetchInterval", "providerHealthRefreshInterval", "hostPowerMonitorActiveInterval", "hostPowerMonitorIdleInterval", "pauseWhenHostLocked", "pauseWhenHostLowPower", "pauseWhenClientLowPower", "pauseWhenOnBattery"];
const same = (a: Resolved, b: Resolved) => KEYS.every((key) => a[key] === b[key]);

/** normalizeBackgroundActivitySettings: a custom policy equal to a preset is that preset; otherwise only the differing overrides stay. */
export function normalizeBackgroundActivity(policy: BackgroundActivity, resolved: Resolved): BackgroundActivity {
  if (policy.profile !== "custom") return { schemaVersion: 1, profile: policy.profile, overrides: {} };
  const base = baseProfile(policy);
  for (const profile of [base, "balanced", "performance", "battery-saver"] as Profile[]) {
    if (same(resolved, PRESETS[profile])) return { schemaVersion: 1, profile, overrides: {} };
  }
  const preset = PRESETS[base];
  return { schemaVersion: 1, profile: "custom", baseProfile: base, overrides: Object.fromEntries(KEYS.filter((key) => resolved[key] !== preset[key]).map((key) => [key, resolved[key]])) };
}

/** resolveBackgroundActivityProfileOption: Advanced while the policy is custom. */
export function profileOption(settings: Dict | null): ProfileOption {
  const resolved = resolveBackgroundActivity(settings);
  const normalized = normalizeBackgroundActivity({ schemaVersion: 1, profile: "custom", baseProfile: resolved.profile, overrides: {} }, resolved);
  return normalized.profile === "custom" ? "advanced" : normalized.profile;
}

/** The patch that picks one of the three profiles outright. */
export const profilePatch = (profile: Profile) => ({ backgroundActivity: { schemaVersion: 1, profile, overrides: {} } });

/** The patch that changes the shared policy and keeps the custom overrides (backgroundActivitySharedPolicySettings). */
export function sharedPolicyPatch(settings: Dict | null, profile: Profile) {
  const policy = readBackgroundActivity(settings);
  return { backgroundActivity: { schemaVersion: 1, profile: "custom", baseProfile: profile, overrides: policy.profile === "custom" ? policy.overrides : {} } };
}

/** The patch that sets one interval or switch as an override of the resolved policy (backgroundActivityOverrideSettings). */
export function overridePatch(settings: Dict | null, change: Partial<Resolved>) {
  const resolved = { ...resolveBackgroundActivity(settings), ...change };
  const policy = readBackgroundActivity(settings);
  const normalized = normalizeBackgroundActivity({ schemaVersion: 1, profile: "custom", baseProfile: baseProfile(policy), overrides: {} }, resolved);
  return { backgroundActivity: normalized };
}

/** The shipped default: Balanced, no overrides. */
export const DEFAULT_BACKGROUND_ACTIVITY: BackgroundActivity = { schemaVersion: 1, profile: "balanced", overrides: {} };
export const resetPatch = () => ({ backgroundActivity: DEFAULT_BACKGROUND_ACTIVITY });
export const isDefaultPolicy = (settings: Dict | null) => { const policy = readBackgroundActivity(settings); return policy.profile === "balanced" && Object.keys(policy.overrides).length === 0; };

/** The description under the row's title. */
export function backgroundDescription(settings: Dict | null): string {
  const option = profileOption(settings);
  const resolved = resolveBackgroundActivity(settings);
  return option === "advanced" ? `${ADVANCED_DESCRIPTION} Shared policy: ${PROFILE_LABELS[resolved.profile]}.` : PROFILE_DESCRIPTIONS[resolved.profile];
}
