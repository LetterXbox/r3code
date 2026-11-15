import { expect, test } from "nsh/test";
import { branchActionFailureTitle, CHECKOUT_PR_PREFIX, CREATE_PREFIX, localNameFromRemoteRef, parsePickerRefs, parsePullRequestReference, pickerItems, refBadge, sanitizeNewRefName, selectionTarget, statusText, triggerLabel } from "./branchLogic";

const refs = parsePickerRefs({
  isRepo: true, nextCursor: 100, totalCount: 240,
  refs: [
    { name: "main", current: true, isDefault: true, worktreePath: "/work/app" },
    { name: "feature/queue", current: false, isDefault: false, worktreePath: null },
    { name: "origin/feature/queue", current: false, isRemote: true, isDefault: false, worktreePath: null },
    { name: "wip", current: false, isDefault: false, worktreePath: "/work/app-wip" },
    { name: 5 },
  ],
}).refs;

test("a query that names no existing ref adds a create row; whitespace becomes dashes", () => {
  expect(sanitizeNewRefName("  my new  branch ")).toBe("my-new-branch");
  const none = pickerItems({ refs, query: "queue", canCreate: true });
  expect(none.items).toEqual(["feature/queue", "origin/feature/queue", `${CREATE_PREFIX}queue`]);
  expect(pickerItems({ refs, query: "main", canCreate: true }).createValue).toBe(null);
  expect(pickerItems({ refs, query: "brand new", canCreate: true }).items).toEqual([`${CREATE_PREFIX}brand new`]);
  expect(pickerItems({ refs, query: "brand new", canCreate: false }).items).toEqual([]);
  expect(pickerItems({ refs, query: "", canCreate: true }).items.length).toBe(4);
});

test("rows wear current, worktree, remote or default, in that order", () => {
  expect(refBadge(refs[0]!, "/work/app")).toBe("current");
  expect(refBadge(refs[3]!, "/work/app")).toBe("worktree");
  expect(refBadge(refs[2]!, "/work/app")).toBe("remote");
  expect(refBadge({ ...refs[1]!, isDefault: true }, "/work/app")).toBe("default");
  expect(refBadge(refs[1]!, "/work/app")).toBe(null);
});

test("a ref held by another worktree is reused in place; others check out where the thread runs", () => {
  expect(selectionTarget({ projectCwd: "/work/app", activeWorktreePath: null, ref: refs[3]! })).toEqual({ checkoutCwd: "/work/app-wip", nextWorktreePath: "/work/app-wip", reuseExistingWorktree: true });
  expect(selectionTarget({ projectCwd: "/work/app", activeWorktreePath: null, ref: refs[0]! })).toMatchObject({ nextWorktreePath: null, reuseExistingWorktree: true });
  expect(selectionTarget({ projectCwd: "/work/app", activeWorktreePath: "/wt", ref: refs[1]! })).toEqual({ checkoutCwd: "/wt", nextWorktreePath: "/wt", reuseExistingWorktree: false });
  expect(selectionTarget({ projectCwd: "/work/app", activeWorktreePath: "/wt", ref: { ...refs[1]!, isDefault: true } }).nextWorktreePath).toBe(null);
});

test("labels and status copy match the web", () => {
  expect(triggerLabel({ selectingWorktreeBase: false, branch: null })).toBe("Select ref");
  expect(triggerLabel({ selectingWorktreeBase: true, branch: "main" })).toBe("From main");
  expect(triggerLabel({ selectingWorktreeBase: false, branch: "main" })).toBe("main");
  expect(localNameFromRemoteRef("origin/feature/queue")).toBe("feature/queue");
  expect(statusText({ loading: false, loadingMore: false, shown: 100, total: 240, hasMore: true })).toBe("Showing 100 of 240 refs");
  expect(statusText({ loading: true, loadingMore: false, shown: 0, total: 0, hasMore: false })).toBe("Loading refs...");
});

test("a pull request reference in the query adds a checkout row ahead of the refs", () => {
  expect(parsePullRequestReference("#12")).toBe("12");
  expect(parsePullRequestReference(" 7 ")).toBe("7");
  expect(parsePullRequestReference("https://github.com/acme/app/pull/31")).toBe("https://github.com/acme/app/pull/31");
  expect(parsePullRequestReference("https://gitlab.com/acme/app/-/merge_requests/4")).toBe("https://gitlab.com/acme/app/-/merge_requests/4");
  expect(parsePullRequestReference("feature/queue")).toBe(null);
  expect(parsePullRequestReference("")).toBe(null);
  const found = pickerItems({ refs, query: "#12", canCreate: true, canCheckoutPullRequest: true });
  expect(found.items[0]).toBe(`${CHECKOUT_PR_PREFIX}12`);
  expect(found.checkoutValue).toBe(`${CHECKOUT_PR_PREFIX}12`);
  expect(pickerItems({ refs, query: "#12", canCreate: true }).checkoutValue).toBe(null);
});

test("a worktree that starts from remote says so when its base is a local branch", () => {
  expect(triggerLabel({ selectingWorktreeBase: true, branch: "main", startFromOrigin: true, branchIsRemote: false })).toBe("From main (remote)");
  expect(triggerLabel({ selectingWorktreeBase: true, branch: "main", startFromOrigin: true, branchIsRemote: null })).toBe("From main");
  expect(triggerLabel({ selectingWorktreeBase: true, branch: "origin/main", startFromOrigin: true, branchIsRemote: true })).toBe("From origin/main");
  expect(triggerLabel({ selectingWorktreeBase: false, branch: "main", startFromOrigin: true, branchIsRemote: false })).toBe("main");
});

test("a failed checkout or create reads the reference's toast titles", () => {
  expect(branchActionFailureTitle("switch")).toBe("Failed to switch ref.");
  expect(branchActionFailureTitle("create")).toBe("Failed to create and switch ref.");
});
