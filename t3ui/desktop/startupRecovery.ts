// app/DesktopStartupRecovery.ts, without the updater branches: this build has none (updateChannel.ts), so the
// reference's Update/Downloading/Checking offers never apply here. What remains is what a build with no updater can
// still do when the backend fails to start, or an administrator's managed policy cannot be used: block the thread
// view behind a full-screen offer instead of leaving a silent toast or an unusable app.
//
// - ManagedPolicy: a policy this build cannot use (managedPolicy.ts ManagedPolicyFileError). No build, newer or
//   older, can fix an administrator's policy; only they can, so this always wins when present.
// - Reinstall: the last build that started successfully on this machine differs from the one now failing to
//   connect. Re-running that known-good build (from the releases page: there is no updater to fetch it) is the
//   best offer short of one.
// - Releases: nothing better is known; send the user to the project's releases page.
import { signal } from "nsh";
import { desktop } from "./runtime";

export type StartupRecoveryOffer =
  | { kind: "managed-policy"; message: string }
  | { kind: "reinstall"; version: string }
  | { kind: "releases" };

/** desktopUpdate.ts DEFAULT_REPOSITORY / AboutPanel's "View project" link: this port's own releases page. */
export const STARTUP_RECOVERY_RELEASES_URL = "https://github.com/pingdotgg/t3code/releases";

const LAST_STARTED_VERSION_KEY = "desktop-last-started-version";

/** The offer in force; null while startup is healthy (or has not been checked). */
export const startupRecoveryOffer = signal<StartupRecoveryOffer | null>(null);

export function presentStartupRecovery(offer: StartupRecoveryOffer): void {
  startupRecoveryOffer.set(offer);
}

export function clearStartupRecovery(): void {
  startupRecoveryOffer.set(null);
}

/** resolveStartupRecoveryOffer, minus the Update/Downloading/Checking branches (no updater). A managed-policy
 * failure always wins; otherwise Reinstall when a different build last started here, else Releases. */
export function resolveStartupRecoveryOffer(input: {
  managedPolicyError: string | null;
  lastStartedVersion: string | null;
  currentVersion: string;
}): StartupRecoveryOffer {
  if (input.managedPolicyError) return { kind: "managed-policy", message: input.managedPolicyError };
  if (input.lastStartedVersion !== null && input.lastStartedVersion !== input.currentVersion) {
    return { kind: "reinstall", version: input.lastStartedVersion };
  }
  return { kind: "releases" };
}

/** The last build that successfully reached a connected backend on this machine (DesktopStartupRecovery's
 * LAST_STARTED_VERSION_FILE), null before any has. */
export async function lastStartedVersion(): Promise<string | null> {
  try { return await desktop().getItem(LAST_STARTED_VERSION_KEY); } catch { return null; }
}

/** Records the build that just reached a connected backend; call only after a successful connect, never at launch
 * (recording unconditionally would make Reinstall always point at the build that is currently failing). */
export async function recordStartedVersion(version: string): Promise<void> {
  try { await desktop().setItem(LAST_STARTED_VERSION_KEY, version); } catch { /* best effort */ }
}

/** Tests only. */
export function resetStartupRecoveryForTest(): void {
  startupRecoveryOffer.set(null);
}
