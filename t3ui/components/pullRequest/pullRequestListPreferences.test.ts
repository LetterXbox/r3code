import { expect, test } from "nsh/test";
import { DEFAULT_PULL_REQUEST_LIST_PREFERENCES, normalizePreferences, readPullRequestListPreferences, writePullRequestListPreferences } from "./pullRequestListPreferences";

test("what is saved is what the list restores, without the defaults", () => {
  const raw = writePullRequestListPreferences({ involvement: "reviewing", state: "all", sort: "newest", q: "fix", draft: "hide", labels: ["bug"], author: "ann", host: "github.com", environmentId: "env-1", projectId: "p1" });
  expect(readPullRequestListPreferences(raw)).toEqual({ involvement: "reviewing", state: "all", sort: "newest", q: "fix", draft: "hide", labels: ["bug"], author: "ann", host: "github.com", environmentId: "env-1", projectId: "p1" });
  // The default sort and empty values are not written.
  expect(JSON.parse(writePullRequestListPreferences({ involvement: "all", state: "open", sort: "ready", q: "", labels: [] }))).toEqual({ involvement: "all", state: "open" });
  expect(normalizePreferences({ involvement: "all", state: "open", review: "none", checks: "failing" })).toEqual({ involvement: "all", state: "open", review: "none", checks: "failing" });
});

test("anything that does not decode is the defaults, never a half-restored list", () => {
  for (const raw of [null, "", "not json", "[]", "null", '{"involvement":"nobody","state":"open"}', '{"involvement":"all","state":"open","sort":"random"}', '{"involvement":"all","state":"open","draft":"maybe"}',
    JSON.stringify({ involvement: "all", state: "open", q: "x".repeat(201) }), JSON.stringify({ involvement: "all", state: "open", labels: Array.from({ length: 11 }, (_, i) => `l${i}`) }), '{"involvement":"all","state":"open","labels":[1]}']) {
    expect(readPullRequestListPreferences(raw)).toEqual(DEFAULT_PULL_REQUEST_LIST_PREFERENCES);
  }
});
