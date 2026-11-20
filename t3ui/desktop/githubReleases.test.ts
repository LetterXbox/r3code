import { expect, test } from "nsh/test";
import { compareRelease, GITHUB_RELEASES_API, pickChannelRelease, releaseNotesText, UPDATE_REPO, type GithubRelease } from "./githubReleases";

const release = (overrides: Partial<GithubRelease>): GithubRelease => ({
  tag_name: "v1.0.0", html_url: "https://github.com/x/y/releases/tag/v1.0.0", draft: false, prerelease: false, ...overrides,
});

test("the API and the repo agree on jasonkneen/r3code (the fork's own remote, not the upstream reference)", () => {
  expect(UPDATE_REPO).toBe("jasonkneen/r3code");
  expect(GITHUB_RELEASES_API).toBe("https://api.github.com/repos/jasonkneen/r3code/releases");
});

test("pickChannelRelease: stable wants the newest non-prerelease, nightly the newest prerelease", () => {
  const releases = [release({ tag_name: "v2.0.0-nightly.3", prerelease: true }), release({ tag_name: "v1.9.0" }), release({ tag_name: "v1.8.0" })];
  expect(pickChannelRelease(releases, "latest")?.tag_name).toBe("v1.9.0");
  expect(pickChannelRelease(releases, "nightly")?.tag_name).toBe("v2.0.0-nightly.3");
});

test("pickChannelRelease: a draft is never picked, and no match is null", () => {
  expect(pickChannelRelease([release({ tag_name: "v3.0.0", draft: true })], "latest")).toBeNull();
  expect(pickChannelRelease([release({ tag_name: "v1.0.0" })], "nightly")).toBeNull();
  expect(pickChannelRelease([], "latest")).toBeNull();
});

test("compareRelease strips a leading v on both sides and reports whether the release is newer", () => {
  expect(compareRelease(release({ tag_name: "v1.2.0" }), "1.1.0")).toEqual({ hasUpdate: true, remoteVersion: "1.2.0" });
  expect(compareRelease(release({ tag_name: "v1.1.0" }), "v1.1.0")).toEqual({ hasUpdate: false, remoteVersion: "1.1.0" });
  expect(compareRelease(release({ tag_name: "1.0.0" }), "1.1.0")).toEqual({ hasUpdate: false, remoteVersion: "1.0.0" });
});

test("releaseNotesText trims the body and is null when there is nothing written", () => {
  expect(releaseNotesText(release({ body: "  - fixed things  \n" }))).toBe("- fixed things");
  expect(releaseNotesText(release({ body: "   " }))).toBeNull();
  expect(releaseNotesText(release({ body: null }))).toBeNull();
  expect(releaseNotesText(release({}))).toBeNull();
});
