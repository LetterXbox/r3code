// UpdateTrackSwitchDialog.tsx and updateTrackSwitch.logic.ts: moving this app and the connected machines between Stable
// and Nightly. The plan (the release to move to, the notes, why it cannot run) is pure; the dialog reads the target
// release from the server's npm registry (`server.getNpmRelease`).
//
// This build has no updater (no DesktopBridge.setUpdateChannel), so the plan can be shown but the switch cannot run:
// `switchBlockedReason` says so, and the About row that opens the dialog is only offered when an updater exists.
export type UpdateChannel = "latest" | "nightly";

export const channelSwitchLabel = (channel: UpdateChannel) => (channel === "nightly" ? "Nightly" : "Stable");

/** desktopUpdateChannelOf: a nightly build carries `nightly` in its prerelease tag. */
export const updateChannelOf = (version: string): UpdateChannel => (/-nightly[.\d-]/.test(version) || version.includes("-nightly") ? "nightly" : "latest");

export interface ChannelSwitchRelease { channel: UpdateChannel; version: string; databaseMigration?: number }

/** readNpmRelease: the release `server.getNpmRelease` answers, or null when it is not one. */
export function readNpmRelease(channel: UpdateChannel, value: unknown): ChannelSwitchRelease | null {
  const item = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  if (!item || typeof item.version !== "string") return null;
  return { channel, version: item.version, ...(typeof item.databaseMigration === "number" ? { databaseMigration: item.databaseMigration } : {}) };
}

/** state/npmRelease.ts unsupportedLookup: why the connected server cannot be asked for a release, or null when it can. */
export function npmReleaseLookupBlock(environment: Record<string, unknown> | null): string | null {
  if (environment === null) return "Connect to this server to check releases.";
  const capabilities = environment.capabilities;
  const supported = typeof capabilities === "object" && capabilities !== null && (capabilities as Record<string, unknown>).npmReleaseLookup === true;
  return supported ? null : "This server does not support registry lookups. Update it before switching tracks.";
}

/** ServerNpmReleaseError's message getter: the reason behind a fixed prefix. */
export const npmReleaseErrorMessage = (reason: string) => `Could not check the configured npm registry: ${reason}`;

/** npmReleaseFailureMessage: the contract error's own text, or one line for any other failure (transport, permission). */
export function npmReleaseFailureMessage(cause: unknown): string {
  const tag = typeof cause === "object" && cause !== null ? (cause as { tag?: unknown }).tag : undefined;
  return tag === "ServerNpmReleaseError" && cause instanceof Error && cause.message
    ? cause.message
    : "Could not check this environment's npm registry. Check the connection and registry settings.";
}

/** The database check of a switch across tracks: the target release must know every migration the database holds. */
export function channelSwitchBlockReason(fromVersion: string, release: ChannelSwitchRelease, currentMigration: number | undefined): string | null {
  if (updateChannelOf(fromVersion) === release.channel) return null;
  const from = channelSwitchLabel(updateChannelOf(fromVersion));
  if (currentMigration === undefined) return `its server predates database checks; update it on ${from} first`;
  if (release.databaseMigration === undefined) return `${release.version} predates database checks; wait for a newer ${channelSwitchLabel(release.channel)} release`;
  return currentMigration > release.databaseMigration
    ? `its database has changes ${release.version} does not support yet; stay on ${from} until ${channelSwitchLabel(release.channel)} has them`
    : null;
}

export interface UpdaterState { enabled: boolean; channelBlockedByPolicy?: boolean }

/** localUpdaterStaysPut: this app's updater is off, so it stays put while the machines move. */
export function localUpdaterStaysPut(state: UpdaterState | null | undefined, target: UpdateChannel): boolean {
  return state?.enabled === false && !(target === "latest" && state.channelBlockedByPolicy === true);
}

export interface SwitchPlan { title: string; notes: string[]; confirmLabel: string; disabledReason: string | null }

/** What the dialog shows for a release. `updater` null is this build: no updater at all. */
export function switchPlan(input: { release: ChannelSwitchRelease; appVersion: string; updater: UpdaterState | null; databaseMigration: number | undefined }): SwitchPlan {
  const label = channelSwitchLabel(input.release.channel);
  const crosses = updateChannelOf(input.appVersion) !== input.release.channel;
  const notes: string[] = [];
  if (input.updater === null) notes.push("This build of R3 Code has no updater, so it cannot switch itself. Reinstall the app from the release page to change track.");
  else if (crosses && localUpdaterStaysPut(input.updater, input.release.channel)) notes.push("This app's updates are off here, so reinstall it yourself to switch.");
  const blocked = channelSwitchBlockReason(input.appVersion, input.release, input.databaseMigration);
  return {
    title: `Switch to ${label}?`,
    notes,
    confirmLabel: `Switch to ${label}`,
    disabledReason: input.updater === null ? "This build has no updater, so it cannot switch track." : blocked === null ? null : `This app cannot switch: ${blocked}.`,
  };
}
