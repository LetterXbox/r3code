import { expect, test } from "nsh/test";
import { activeFilterCount, buildListView, effectiveFilters, resolveAuthorFilter, listRequest, matchesFilters, parsePullRequestQuery } from "./pullRequestList.logic";

test("filter count includes host, environment, project, state and every chosen label", () => {
  expect(activeFilterCount({}, "open", "all")).toBe(0);
  expect(activeFilterCount({ labels: ["bug", "ui"], draft: "hide" }, "closed", "reviewing", {
    host: "github", environmentId: "remote", projectId: "project",
  })).toBe(8);
});

// Cases of packages/client-runtime pullRequestQuery.test.ts, with the groups named `labelGroups`.
test("quoted values stay whole and negation is separate", () => {
  expect(parsePullRequestQuery('label:"needs design" -label:wip Fix the parser')).toEqual({ text: "Fix the parser", filters: { labelGroups: [["needs design"]], excludedLabels: ["wip"] } });
});

test("a list keeps the spaces of a quoted name and drops an empty part; each qualifier is its own group", () => {
  expect(parsePullRequestQuery('label:"needs design","wip"').filters.labelGroups).toEqual([["needs design", "wip"]]);
  expect(parsePullRequestQuery("label:a,,b").filters.labelGroups).toEqual([["a", "b"]]);
  expect(parsePullRequestQuery("label:bug label:a,b").filters.labelGroups).toEqual([["bug"], ["a", "b"]]);
  expect(parsePullRequestQuery('label:"needs,triage",wip').filters.labelGroups).toEqual([["needs,triage", "wip"]]);
});

test("scalar qualifiers read in GitHub's spelling", () => {
  expect(parsePullRequestQuery("author:octocat DRAFT:false review:changes_requested status:failure").filters).toEqual({ author: "octocat", draft: "hide", review: "changes-requested", checks: "failing" });
  expect(parsePullRequestQuery("draft:true checks:passing review:required").filters).toEqual({ draft: "only", checks: "passing", review: "review-required" });
});

test("an unknown value and a stray colon stay text, and an unknown key is a scoped label", () => {
  const parsed = parsePullRequestQuery("milestone:v2 draft:maybe status: parser");
  expect(parsed.filters).toEqual({ labelGroups: [["milestone:v2"]] });
  expect(parsed.text).toBe("draft:maybe status: parser");
  expect(parsePullRequestQuery("size:S,XS").filters.labelGroups).toEqual([["size:S", "size:XS"]]);
  expect(parsePullRequestQuery("size:S,size:XS").filters.labelGroups).toEqual([["size:S", "size:XS"]]);
  expect(parsePullRequestQuery("size:XXL").text).toBe("");
});

test("a typed query is cut back to what the contract carries", () => {
  const many = Array.from({ length: 14 }, (_, index) => `l${index}`).join(",");
  const long = "x".repeat(240);
  const parsed = parsePullRequestQuery(`label:${many} label:${long} author:${long}`);
  expect(parsed.filters.labelGroups?.[0]).toHaveLength(10);
  expect(parsed.filters.labelGroups?.[1]).toEqual(["x".repeat(200)]);
  expect(parsed.filters.author).toBe("x".repeat(200));
});

test("the request sends the search box's qualifiers to the server, over the menu's", () => {
  expect(listRequest({ state: "open", involvement: "all", filters: { draft: "only", labels: ["bug"] }, query: 'fix author:octocat -label:wip draft:false review:approved', limit: 100 })).toEqual({
    state: "open", involvement: "all",
    filters: { draft: "hide", review: "approved", author: "octocat", excludedLabels: ["wip"], labels: [["bug"]] },
    query: "fix", limit: 100,
  });
  // A typed label replaces the menu's labels, as the web's spread does.
  expect(effectiveFilters({ labels: ["bug"] }, "label:ui").filters).toEqual({ labelGroups: [["ui"]] });
});

test("rows are filtered locally by the same qualifiers while the request is in flight", () => {
  const entry = (patch: object) => ({ labels: [], isDraft: false, reviewDecision: "", checksState: "", author: "ann", ...patch }) as never;
  const filters = effectiveFilters({}, "label:a,b -label:wip author:ANN").filters;
  expect(matchesFilters(entry({ labels: [{ name: "B", color: "" }] }), filters)).toBe(true);
  expect(matchesFilters(entry({ labels: [{ name: "b", color: "" }, { name: "wip", color: "" }] }), filters)).toBe(false);
  expect(matchesFilters(entry({ labels: [] }), filters)).toBe(false);
  expect(matchesFilters(entry({ labels: [{ name: "a", color: "" }], author: "bob" }), filters)).toBe(false);
  expect(typeof buildListView).toBe("function");
});

test("author:me is compared against the viewer's login, as the server resolves it", () => {
  const entry = { labels: [], isDraft: false, reviewDecision: "", checksState: "", author: "Ann" } as never;
  expect(resolveAuthorFilter("me", "ann")).toBe("ann");
  expect(resolveAuthorFilter("@ME", "ann")).toBe("ann");
  expect(resolveAuthorFilter("bob", "ann")).toBe("bob");
  expect(resolveAuthorFilter("me", null)).toBe("me");
  const filters = effectiveFilters({}, "author:@me").filters;
  expect(matchesFilters(entry, filters, "ann")).toBe(true);
  expect(matchesFilters(entry, filters, "bob")).toBe(false);
  expect(matchesFilters(entry, filters)).toBe(false);
});

test("a row the query only matched in its description is marked; a title, number or branch match is not", async () => {
  const { matchedElsewhere, scorePullRequestMatch } = await import("./pullRequestList.logic");
  const entry = { number: 12, title: "Fix the parser", headBranch: "fix/parser", author: "ada", repository: "o/r" };
  expect(scorePullRequestMatch(entry, "#12")).toBe(100);
  expect(matchedElsewhere(entry, "parser")).toBe(false);
  expect(matchedElsewhere(entry, "tokenizer")).toBe(true);
  expect(matchedElsewhere(entry, "")).toBe(false);
});
