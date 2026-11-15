// The Advanced section's health-check interval: a port of the background-activity resolution in
// packages/shared/src/backgroundActivitySettings.ts and backgroundActivityOverrideSettings, on the
// wire's millisecond durations.
import { rec } from "./logic";

export type BackgroundProfile = "balanced" | "performance" | "battery-saver";
export const PROVIDER_HEALTH_INTERVAL_STEP_SECONDS = 30;

interface Resolved {
  profile: BackgroundProfile;
  automaticGitFetchInterval: number; providerHealthRefreshInterval: number;
  hostPowerMonitorActiveInterval: number; hostPowerMonitorIdleInterval: number;
  pauseWhenHostLocked: boolean; pauseWhenHostLowPower: boolean; pauseWhenClientLowPower: boolean; pauseWhenOnBattery: boolean;
}
const seconds = (n: number) => n * 1000;
const minutes = (n: number) => n * 60_000;
const PRESETS: Record<BackgroundProfile, Resolved> = {
  performance: { profile: "performance", automaticGitFetchInterval: seconds(15), providerHealthRefreshInterval: minutes(1), hostPowerMonitorActiveInterval: seconds(30), hostPowerMonitorIdleInterval: minutes(2), pauseWhenHostLocked: true, pauseWhenHostLowPower: false, pauseWhenClientLowPower: false, pauseWhenOnBattery: false },
  balanced: { profile: "balanced", automaticGitFetchInterval: seconds(30), providerHealthRefreshInterval: minutes(5), hostPowerMonitorActiveInterval: seconds(30), hostPowerMonitorIdleInterval: minutes(5), pauseWhenHostLocked: true, pauseWhenHostLowPower: true, pauseWhenClientLowPower: true, pauseWhenOnBattery: false },
  "battery-saver": { profile: "battery-saver", automaticGitFetchInterval: 0, providerHealthRefreshInterval: minutes(15), hostPowerMonitorActiveInterval: minutes(1), hostPowerMonitorIdleInterval: minutes(10), pauseWhenHostLocked: true, pauseWhenHostLowPower: true, pauseWhenClientLowPower: true, pauseWhenOnBattery: true },
};
const isProfile = (value: unknown): value is BackgroundProfile => value === "balanced" || value === "performance" || value === "battery-saver";
const ms = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const flag = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined;

function baseProfile(activity: Record<string, unknown>): BackgroundProfile {
  if (activity.profile === "custom") return isProfile(activity.baseProfile) ? activity.baseProfile : "balanced";
  return isProfile(activity.profile) ? activity.profile : "balanced";
}
function resolveActivity(activity: Record<string, unknown>): Resolved {
  const base = baseProfile(activity);
  const preset = PRESETS[base];
  const overrides = activity.profile === "custom" ? rec(activity.overrides) ?? {} : {};
  return {
    profile: base,
    automaticGitFetchInterval: ms(overrides.automaticGitFetchInterval) ?? preset.automaticGitFetchInterval,
    providerHealthRefreshInterval: ms(overrides.providerHealthRefreshInterval) ?? preset.providerHealthRefreshInterval,
    hostPowerMonitorActiveInterval: ms(overrides.hostPowerMonitorActiveInterval) ?? preset.hostPowerMonitorActiveInterval,
    hostPowerMonitorIdleInterval: ms(overrides.hostPowerMonitorIdleInterval) ?? preset.hostPowerMonitorIdleInterval,
    pauseWhenHostLocked: flag(overrides.pauseWhenHostLocked) ?? preset.pauseWhenHostLocked,
    pauseWhenHostLowPower: flag(overrides.pauseWhenHostLowPower) ?? preset.pauseWhenHostLowPower,
    pauseWhenClientLowPower: flag(overrides.pauseWhenClientLowPower) ?? preset.pauseWhenClientLowPower,
    pauseWhenOnBattery: flag(overrides.pauseWhenOnBattery) ?? preset.pauseWhenOnBattery,
  };
}

/** The server's effective background activity, folding in the legacy top-level interval fields. */
export function resolveServerBackgroundActivity(settings: Record<string, unknown>): Resolved {
  const activity = rec(settings.backgroundActivity) ?? { profile: "balanced", overrides: {} };
  const isDefault = (activity.profile ?? "balanced") === "balanced" && activity.baseProfile === undefined && Object.keys(rec(activity.overrides) ?? {}).length === 0;
  const legacyProfile = isProfile(settings.backgroundActivityProfile) ? settings.backgroundActivityProfile : "balanced";
  const git = ms(settings.automaticGitFetchInterval) ?? PRESETS.balanced.automaticGitFetchInterval;
  const health = ms(settings.providerHealthRefreshInterval) ?? PRESETS.balanced.providerHealthRefreshInterval;
  const preset = PRESETS[legacyProfile];
  const hasLegacy = legacyProfile !== "balanced" || git !== PRESETS.balanced.automaticGitFetchInterval || health !== PRESETS.balanced.providerHealthRefreshInterval;
  if (isDefault && hasLegacy) {
    const matches = git === preset.automaticGitFetchInterval && health === preset.providerHealthRefreshInterval;
    return resolveActivity({
      profile: matches ? legacyProfile : "custom", baseProfile: legacyProfile,
      overrides: { ...(git !== preset.automaticGitFetchInterval ? { automaticGitFetchInterval: git } : {}), ...(health !== preset.providerHealthRefreshInterval ? { providerHealthRefreshInterval: health } : {}) },
    });
  }
  return resolveActivity(activity);
}

export function providerHealthSeconds(settings: Record<string, unknown>): number {
  return Math.round(resolveServerBackgroundActivity(settings).providerHealthRefreshInterval / 1000);
}
/** What the profile's own preset would use, so the reset control only shows for a custom interval. */
export function defaultProviderHealthSeconds(settings: Record<string, unknown>): number {
  return Math.round(PRESETS[resolveServerBackgroundActivity(settings).profile].providerHealthRefreshInterval / 1000);
}
export function normalizeIntervalSeconds(value: number | null, minimum = 0): number {
  return value === null || !Number.isFinite(value) ? minimum : Math.max(minimum, Math.round(value));
}

/** The settings patch that pins the provider health interval (or, with undefined, drops its override). */
export function providerHealthPatch(settings: Record<string, unknown>, intervalSeconds: number | undefined): Record<string, unknown> {
  const resolved = resolveServerBackgroundActivity(settings);
  const activity = rec(settings.backgroundActivity) ?? {};
  const overrides: Record<string, unknown> = {
    automaticGitFetchInterval: resolved.automaticGitFetchInterval,
    providerHealthRefreshInterval: resolved.providerHealthRefreshInterval,
    hostPowerMonitorActiveInterval: resolved.hostPowerMonitorActiveInterval,
    hostPowerMonitorIdleInterval: resolved.hostPowerMonitorIdleInterval,
    pauseWhenHostLocked: resolved.pauseWhenHostLocked,
    pauseWhenHostLowPower: resolved.pauseWhenHostLowPower,
    pauseWhenClientLowPower: resolved.pauseWhenClientLowPower,
    pauseWhenOnBattery: resolved.pauseWhenOnBattery,
  };
  if (intervalSeconds === undefined) delete overrides.providerHealthRefreshInterval; else overrides.providerHealthRefreshInterval = intervalSeconds * 1000;
  return { backgroundActivity: { schemaVersion: 1, profile: "custom", baseProfile: baseProfile(activity), overrides } };
}
