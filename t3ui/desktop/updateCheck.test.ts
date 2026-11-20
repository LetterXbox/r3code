// Every test fakes the runtime's `fetch` (never the real GitHub API) and resets the update-channel signal, so
// each test resolves its own channel from a fresh "no saved choice" state.
import { expect, test } from "nsh/test";
import { buildIdentity } from "../buildIdentity";
import type { GithubRelease } from "./githubReleases";
import { configureDesktop, type DesktopFetchResponse } from "./runtime";
import { resetUpdateChannelForTest } from "./updateChannel";
import { checkForUpdates, evaluateReleases, resetBackgroundUpdateChecksForTest, updateToastInput } from "./updateCheck";

const release = (overrides: Partial<GithubRelease>): GithubRelease => ({
  tag_name: "v9.9.9", html_url: "https://github.com/jasonkneen/r3code/releases/tag/v9.9.9", draft: false, prerelease: false, ...overrides,
});

function fakeFetch(response: DesktopFetchResponse) {
  configureDesktop({ fetch: async () => response, getItem: async () => null, setItem: async () => {}, openUrl: async () => true });
}

function withIdentity(version: string, run: () => Promise<void> | void) {
  const saved = buildIdentity.r3Version;
  buildIdentity.r3Version = version;
  resetUpdateChannelForTest();
  resetBackgroundUpdateChecksForTest();
  return Promise.resolve(run()).finally(() => { buildIdentity.r3Version = saved; });
}

test("evaluateReleases: a newer stable release is available; the current one is up to date", () => {
  expect(evaluateReleases([release({ tag_name: "v2.0.0" })], "latest", "1.0.0").status).toBe("available");
  expect(evaluateReleases([release({ tag_name: "v1.0.0" })], "latest", "1.0.0").status).toBe("up-to-date");
});

test("evaluateReleases: no releases at all, and no release on the requested channel, are both up-to-date with a reason", () => {
  expect(evaluateReleases([], "latest", "1.0.0").message).toBe("No releases published yet.");
  expect(evaluateReleases([release({ tag_name: "v1.0.0" })], "nightly", "1.0.0").message).toBe("No nightly releases published yet.");
});

test("checkForUpdates: a 200 with a newer release reports available, with notes and the release URL", async () => {
  await withIdentity("1.0.0", async () => {
    fakeFetch({ ok: true, status: 200, json: async () => [release({ tag_name: "v1.1.0", body: "- a fix" })] });
    const state = await checkForUpdates();
    expect(state.status).toBe("available");
    expect(state.availableVersion).toBe("1.1.0");
    expect(state.releaseNotes).toBe("- a fix");
    expect(state.releaseUrl).toContain("jasonkneen/r3code");
  });
});

test("checkForUpdates: rate-limited (403) and offline (a throwing fetch) are both reported, not silently swallowed", async () => {
  await withIdentity("1.0.0", async () => {
    fakeFetch({ ok: false, status: 403, json: async () => ({}) });
    expect((await checkForUpdates()).message).toBe("GitHub API rate limit exceeded. Try again later.");

    configureDesktop({ fetch: async () => { throw new Error("offline"); }, getItem: async () => null, setItem: async () => {} });
    const offline = await checkForUpdates();
    expect(offline.status).toBe("error");
    expect(offline.message).toContain("internet connection");
  });
});

test("checkForUpdates: no releases published yet is reported as up-to-date, not an error", async () => {
  await withIdentity("1.0.0", async () => {
    fakeFetch({ ok: true, status: 200, json: async () => [] });
    const state = await checkForUpdates();
    expect(state.status).toBe("up-to-date");
    expect(state.message).toBe("No releases published yet.");
  });
});

test("updateToastInput: an available release offers an 'Open release page' action that calls openUrl", async () => {
  let opened: string | null = null;
  configureDesktop({ openUrl: async (url) => { opened = url; return true; } });
  const toast = updateToastInput({ status: "available", channel: "latest", currentVersion: "1.0.0", availableVersion: "1.1.0", releaseUrl: "https://github.com/jasonkneen/r3code/releases/tag/v1.1.0", releaseNotes: null, checkedAt: null, message: null });
  expect(toast.title).toBe("R3 Code 1.1.0 is available");
  toast.actions?.[0]?.run();
  await Promise.resolve();
  expect(opened).toBe("https://github.com/jasonkneen/r3code/releases/tag/v1.1.0");
});

test("updateToastInput: up-to-date and error both say so plainly, with no action offered", () => {
  const upToDate = updateToastInput({ status: "up-to-date", channel: "latest", currentVersion: "1.0.0", availableVersion: null, releaseUrl: null, releaseNotes: null, checkedAt: null, message: null });
  expect(upToDate.title).toBe("You're up to date");
  expect(upToDate.actions).toBeUndefined();

  const error = updateToastInput({ status: "error", channel: "latest", currentVersion: "1.0.0", availableVersion: null, releaseUrl: null, releaseNotes: null, checkedAt: null, message: "Could not reach GitHub. Check your internet connection." });
  expect(error.title).toBe("Couldn't check for updates");
  expect(error.description).toContain("internet connection");
});
