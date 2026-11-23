// R3 Code has no auto-updater: the app is ad-hoc signed and not notarized, so a silent download+install is
// intentionally absent (intentional product decision). This module only answers
// "is a newer release published on GitHub" for updateCheck.ts; it never downloads, verifies or runs an installer.
// The only follow-on action offered anywhere is opening the release page in the browser.
import { compareVersions } from "../components/composer/modelPickerNotices";
import type { UpdateChannel } from "../pages/settings/updateTrackSwitch";

/** This fork's own repo (confirmed from `git remote -v` origin), not the upstream pingdotgg/t3code releases page
 * linked from startupRecovery.ts, which is an unrelated "no updater, go reinstall by hand" offer. */
export const UPDATE_REPO = "jasonkneen/r3code";
export const GITHUB_RELEASES_API = `https://api.github.com/repos/${UPDATE_REPO}/releases`;
export const GITHUB_RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases`;

/** The subset of GitHub's release object (`GET /repos/{owner}/{repo}/releases`) this checker reads. */
export interface GithubRelease {
  tag_name: string;
  name?: string | null;
  body?: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
}

const stripV = (tag: string) => (tag.startsWith("v") ? tag.slice(1) : tag);

/** The release a channel tracks: GitHub lists releases newest-first, so the first non-draft release whose
 * `prerelease` flag matches the channel ("nightly" wants a prerelease, stable wants a full release) is the
 * newest one for that channel. `null` when the channel has no release yet. */
export function pickChannelRelease(releases: readonly GithubRelease[], channel: UpdateChannel): GithubRelease | null {
  const wantsPrerelease = channel === "nightly";
  return releases.find((release) => !release.draft && release.prerelease === wantsPrerelease) ?? null;
}

export interface ReleaseComparison { hasUpdate: boolean; remoteVersion: string }

/** Whether `release` is newer than the running build (both compared with a leading "v" stripped). */
export function compareRelease(release: GithubRelease, currentVersion: string): ReleaseComparison {
  const remoteVersion = stripV(release.tag_name);
  return { hasUpdate: compareVersions(remoteVersion, stripV(currentVersion)) > 0, remoteVersion };
}

/** The release body, trimmed; `null` for a release with no notes written. */
export function releaseNotesText(release: GithubRelease): string | null {
  const body = release.body?.trim();
  return body && body.length > 0 ? body : null;
}
