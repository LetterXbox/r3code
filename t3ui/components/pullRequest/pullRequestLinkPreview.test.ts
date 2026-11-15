import { expect, test } from "nsh/test";
import { parsePullRequestLink, parsePullRequestPreview, previewAuthorLabel } from "./pullRequestLinkPreview.logic";

test("pull request links of each host name a repository and number; other links are not taken", () => {
  expect(parsePullRequestLink("https://github.com/acme/t3code/pull/12")).toEqual({ host: "github.com", repository: "acme/t3code", number: 12 });
  expect(parsePullRequestLink("https://gitlab.com/group/sub/proj/-/merge_requests/5")).toEqual({ host: "gitlab.com", repository: "group/sub/proj", number: 5 });
  expect(parsePullRequestLink("https://dev.azure.com/org/proj/_git/repo/pullrequest/9")?.number).toBe(9);
  expect(parsePullRequestLink("https://github.com/acme/t3code/issues/12")).toBeNull();
  expect(parsePullRequestLink("mailto:a@b.c")).toBeNull();
  expect(parsePullRequestLink("not a url")).toBeNull();
});

test("a contract-shaped preview is read, and the author reads as the web writes it", () => {
  const card = parsePullRequestPreview({ projectId: "p1", repository: "acme/t3code", number: 12, title: "Fix it", url: "https://github.com/acme/t3code/pull/12", author: { login: "octocat", name: "The Octocat", avatarUrl: null }, state: "merged", isDraft: false, createdAt: "2026-11-01T00:00:00.000Z" });
  expect(card).toMatchObject({ repository: "acme/t3code", number: 12, state: "merged" });
  expect(previewAuthorLabel(card.author)).toBe("The Octocat (@octocat)");
  expect(previewAuthorLabel(null)).toBe("ghost");
  expect(previewAuthorLabel({ login: "mona", name: "mona" })).toBe("mona");
  expect(() => parsePullRequestPreview({})).toThrow();
});

import { createPullRequestLinkPreviewModel } from "./PullRequestLinkPreview";

test("pressing a pull request link reads the preview through the open pull request's project, then Open goes to the app or the host", async () => {
  const asked: unknown[] = []; const opened: string[] = []; let inApp = false;
  const model = createPullRequestLinkPreviewModel({
    request: async (method, payload) => { asked.push([method, payload]); return { projectId: "p1", repository: "acme/t3code", number: 12, title: "Fix it", url: "https://github.com/acme/t3code/pull/12", author: null, state: "open", isDraft: false, createdAt: "2026-11-01T00:00:00.000Z" }; },
    projectId: () => "p1", openInApp: () => inApp, openOnHost: (url) => opened.push(url),
  });
  expect(model.handle("https://example.com/page")).toBe(false);
  expect(model.handle("https://github.com/acme/t3code/pull/12")).toBe(true);
  expect(model.state()?.status).toBe("loading");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(model.state()?.status).toBe("ready");
  expect(asked).toEqual([["pullRequests.preview", { projectId: "p1", host: "github.com", repository: "acme/t3code", number: 12 }]]);
  model.open();
  expect(opened).toEqual(["https://github.com/acme/t3code/pull/12"]);
  expect(model.state()).toBeNull();
  inApp = true;
  model.handle("https://github.com/acme/t3code/pull/12");
  await new Promise((resolve) => setTimeout(resolve, 0));
  model.open();
  expect(opened).toHaveLength(1);
});

test("a link with no open pull request to read it through is left to the default", () => {
  const model = createPullRequestLinkPreviewModel({ request: async () => ({}), projectId: () => null, openInApp: () => false, openOnHost: () => undefined });
  expect(model.handle("https://github.com/acme/t3code/pull/12")).toBe(false);
});
