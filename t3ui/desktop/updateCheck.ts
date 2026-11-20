// The check-only updater: no download, no install. R3 Code is ad-hoc signed and not notarized, so this build never
// silently replaces itself; the only thing on offer is telling the user a newer release exists on GitHub, with its
// notes and an "Open release page" button (desktop().openUrl). Runs on startup, once a day, and on the menu's
// "Check for Updates..." (appCommands.ts). Modelled loosely on the reference's DesktopUpdateState (packages/
// contracts ipc.ts), trimmed to the statuses that make sense with no download/install: idle, checking, available,
// up-to-date, error.
import { buildIdentity } from "../buildIdentity";
import { showToast, type ToastInput } from "../components/toast/toastState";
import { compareRelease, type GithubRelease, GITHUB_RELEASES_API, pickChannelRelease, releaseNotesText } from "./githubReleases";
import { desktop } from "./runtime";
import { desktopUpdateChannel, loadUpdateChannel } from "./updateChannel";
import { updateChannelOf, type UpdateChannel } from "../pages/settings/updateTrackSwitch";

export type UpdateCheckStatus = "idle" | "checking" | "available" | "up-to-date" | "error";

export interface UpdateCheckState {
  status: UpdateCheckStatus;
  channel: UpdateChannel;
  currentVersion: string;
  availableVersion: string | null;
  releaseUrl: string | null;
  releaseNotes: string | null;
  checkedAt: string | null;
  message: string | null;
}

const RATE_LIMIT_MESSAGE = "GitHub API rate limit exceeded. Try again later.";
const OFFLINE_MESSAGE = "Could not reach GitHub. Check your internet connection.";

function classifyHttpFailure(status: number): string {
  if (status === 403 || status === 429) return RATE_LIMIT_MESSAGE;
  if (status === 404) return "The release feed could not be found.";
  return `GitHub returned an error (${status}).`;
}

const base = (channel: UpdateChannel, currentVersion: string): Omit<UpdateCheckState, "status" | "message"> => ({
  channel, currentVersion, availableVersion: null, releaseUrl: null, releaseNotes: null, checkedAt: new Date().toISOString(),
});

/** The decision given a resolved releases array: everything here is pure and covered without a network call.
 * `checkForUpdates` below is the only place that touches HTTP. */
export function evaluateReleases(releases: readonly GithubRelease[], channel: UpdateChannel, currentVersion: string): UpdateCheckState {
  if (releases.length === 0) return { ...base(channel, currentVersion), status: "up-to-date", message: "No releases published yet." };
  const release = pickChannelRelease(releases, channel);
  if (!release) {
    return { ...base(channel, currentVersion), status: "up-to-date", message: `No ${channel === "nightly" ? "nightly" : "stable"} releases published yet.` };
  }
  const { hasUpdate, remoteVersion } = compareRelease(release, currentVersion);
  if (!hasUpdate) return { ...base(channel, currentVersion), status: "up-to-date", message: null };
  return { ...base(channel, currentVersion), status: "available", message: null, availableVersion: remoteVersion, releaseUrl: release.html_url, releaseNotes: releaseNotesText(release) };
}

/** The one network call this module makes, entirely behind the `desktop()` runtime seam so no test ever reaches
 * the real GitHub API. Honours the persisted update channel (updateChannel.ts), falling back to the channel of
 * the running build until a saved choice has loaded. */
export async function checkForUpdates(): Promise<UpdateCheckState> {
  const currentVersion = buildIdentity.r3Version;
  await loadUpdateChannel(currentVersion);
  const channel = desktopUpdateChannel() ?? updateChannelOf(currentVersion);
  try {
    const response = await desktop().fetch(GITHUB_RELEASES_API);
    if (!response.ok) return { ...base(channel, currentVersion), status: "error", message: classifyHttpFailure(response.status) };
    const body = await response.json();
    const releases = Array.isArray(body) ? (body as GithubRelease[]) : [];
    return evaluateReleases(releases, channel, currentVersion);
  } catch {
    return { ...base(channel, currentVersion), status: "error", message: OFFLINE_MESSAGE };
  }
}

/** The toast for a finished check. `up-to-date`/`error` only matter for the manual command; the background
 * check (below) only ever shows the `available` one, so a healthy app never nags on its own. */
export function updateToastInput(state: UpdateCheckState): ToastInput {
  if (state.status === "available") {
    return {
      type: "info",
      title: `R3 Code ${state.availableVersion} is available`,
      description: state.releaseNotes ?? `A new ${state.channel === "nightly" ? "nightly" : "stable"} release is ready to view.`,
      actions: state.releaseUrl ? [{ label: "Open release page", run: () => { void desktop().openUrl(state.releaseUrl as string); } }] : [],
    };
  }
  if (state.status === "up-to-date") {
    return { type: "success", title: "You're up to date", description: state.message ?? `R3 Code ${state.currentVersion} is the latest version.` };
  }
  return { type: "error", title: "Couldn't check for updates", description: state.message ?? "An unknown error occurred." };
}

/** "Check for Updates...": always shows a result, including a failure (no more silent "Updates unavailable").
 * Returns the toast's id (tests read it back; the menu command itself ignores it). */
export async function showUpdateCheckToast(): Promise<string> {
  return showToast(updateToastInput(await checkForUpdates()));
}

const DAILY_MS = 24 * 60 * 60 * 1000;
let scheduled = false;

/** Startup + daily background check. Silent unless a newer release is found. Idempotent; App.tsx calls it once. */
export function startBackgroundUpdateChecks(): void {
  if (scheduled) return;
  scheduled = true;
  const runSilently = () => { void checkForUpdates().then((state) => { if (state.status === "available") showToast(updateToastInput(state)); }); };
  runSilently();
  setInterval(runSilently, DAILY_MS);
}

/** Tests only. */
export function resetBackgroundUpdateChecksForTest() { scheduled = false; }
