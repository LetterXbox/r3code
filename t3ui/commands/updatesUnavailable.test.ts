// "Check for Updates..." (DesktopApplicationMenu's item, wired through APP_COMMAND.checkForUpdates in
// appCommands.ts to desktop/updateCheck.ts's showUpdateCheckToast): no updater, but a real check-only GitHub
// query now backs it — a toast with its real result, never a canned "Updates unavailable". The fetch is always
// faked here (configureDesktop); this never reaches the real GitHub API.
import { expect, test } from "nsh/test";
import { buildIdentity } from "../buildIdentity";
import { showUpdateCheckToast } from "../desktop/updateCheck";
import type { GithubRelease } from "../desktop/githubReleases";
import { configureDesktop } from "../desktop/runtime";
import { resetUpdateChannelForTest } from "../desktop/updateChannel";
import { clearToasts, toastById } from "../components/toast/toastState";

const release = (tag: string, extra: Partial<GithubRelease> = {}): GithubRelease => ({
  tag_name: tag, html_url: `https://github.com/jasonkneen/r3code/releases/tag/${tag}`, draft: false, prerelease: false, ...extra,
});

async function checkAndShow(releases: GithubRelease[] | { status: number }) {
  const saved = buildIdentity.r3Version;
  buildIdentity.r3Version = "1.0.0";
  resetUpdateChannelForTest();
  clearToasts();
  configureDesktop({
    getItem: async () => null, setItem: async () => {},
    fetch: async () => (Array.isArray(releases)
      ? { ok: true, status: 200, json: async () => releases }
      : { ok: false, status: releases.status, json: async () => ({}) }),
  });
  const id = await showUpdateCheckToast();
  buildIdentity.r3Version = saved;
  const toast = toastById(id);
  clearToasts();
  return toast;
}

test("a newer release shows it, with its notes and an action — not a generic 'unavailable' box", async () => {
  const toast = await checkAndShow([release("v1.1.0", { body: "- improved things" })]);
  expect(toast?.title).toBe("R3 Code 1.1.0 is available");
  expect(toast?.description).toBe("- improved things");
  expect(toast?.actions[0]?.label).toBe("Open release page");
});

test("already current says so honestly, and claims nothing is wrong", async () => {
  const toast = await checkAndShow([release("v1.0.0")]);
  expect(toast?.title).toBe("You're up to date");
  expect(toast?.type).toBe("success");
});

test("offline or rate-limited is reported as an error, never swallowed into 'unavailable'", async () => {
  const toast = await checkAndShow({ status: 403 });
  expect(toast?.title).toBe("Couldn't check for updates");
  expect(toast?.description).toBe("GitHub API rate limit exceeded. Try again later.");
});

test("no releases published yet is reported plainly, not as a feed-configuration excuse", async () => {
  const toast = await checkAndShow([]);
  expect(toast?.title).toBe("You're up to date");
  expect(toast?.description).toBe("No releases published yet.");
});
