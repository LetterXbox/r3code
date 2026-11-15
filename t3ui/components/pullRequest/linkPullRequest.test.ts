import { expect, test } from "nsh/test";
import { linkValidation, parsePullRequestUrl, resolveLinkPullRequestInput } from "./linkPullRequestState";

test("a pull request URL resolves to its host, repository and number", () => {
  expect(parsePullRequestUrl("https://github.com/acme/t3code/pull/42?x=1")).toEqual({ host: "github.com", repository: "acme/t3code", number: 42, url: "https://github.com/acme/t3code/pull/42" });
  expect(parsePullRequestUrl("https://gitlab.com/grp/sub/repo/-/merge_requests/7")?.repository).toBe("grp/sub/repo");
  expect(parsePullRequestUrl("https://github.com/acme/t3code/issues/42")).toBeNull();
});

test("a bare number needs a repository, else the web's own message", () => {
  expect(resolveLinkPullRequestInput("#12")).toEqual({ error: "Paste the full pull request URL; this thread has no repository to resolve the number against." });
  expect(resolveLinkPullRequestInput("12", { host: "github.com", repository: "a/b", webUrl: (n) => `https://github.com/a/b/pull/${n}` })).toEqual({ link: { host: "github.com", repository: "a/b", number: 12, url: "https://github.com/a/b/pull/12" } });
  expect(resolveLinkPullRequestInput("nope")).toBeNull();
  expect(resolveLinkPullRequestInput("0")).toBeNull();
});

test("validation waits for typing and uses the web's copy", () => {
  expect(linkValidation("", null, false)).toBeNull();
  expect(linkValidation("", null, true)).toBe("Paste a pull request URL or enter 123 / #123.");
  expect(linkValidation("zz", null, true)).toBe("Use a pull request URL, 123, or #123.");
  expect(linkValidation("#1", { error: "boom" }, true)).toBe("boom");
});
