import { expect, test } from "nsh/test";
import { branchTriggerLabel, envModeLabel, lockedEnvModeLabel, parseWorkspaceRefs, previousWorktreeLabel, resolvePreviousWorktreeSeed } from "./workspaceRefs";

test("workspace refs retain actual branch and worktree names", () => {
  expect(parseWorkspaceRefs({ isRepo: true, refs: [
    { name: "main", current: true, worktreePath: "/repo", isRemote: false },
    { name: "feature", worktreePath: "/tmp/feature" },
    { name: "", worktreePath: null },
  ] })).toEqual({ isRepo: true, refs: [
    { name: "main", current: true, worktreePath: "/repo", isRemote: false },
    { name: "feature", current: false, worktreePath: "/tmp/feature", isRemote: false },
  ], hasMore: false });
});

test("invalid branch lists are not treated as available refs", () => {
  expect(() => parseWorkspaceRefs({ refs: [] })).toThrow("invalid branch list");
  expect(() => parseWorkspaceRefs(null)).toThrow("invalid branch list");
});

test("the project folder and a nested project map to their containing checkout", async () => {
  const { checkoutContainsProject } = await import("./workspaceRefs");
  expect(checkoutContainsProject("/repo", "/repo/packages/app")).toBe(true);
  expect(checkoutContainsProject("/repo", "/repo-other")).toBe(false);
  expect(checkoutContainsProject("C:\\repo", "C:\\repo\\app")).toBe(true);
});

test("a paginated branch list reports more results", () => {
  expect(parseWorkspaceRefs({ isRepo: true, refs: [], nextCursor: 100 }).hasMore).toBe(true);
  expect(parseWorkspaceRefs({ isRepo: true, refs: [], nextCursor: null }).hasMore).toBe(false);
});

test("toolbar labels use the web app's copy", () => {
  expect(envModeLabel({ type: "root" })).toBe("Current checkout");
  expect(envModeLabel({ type: "worktree", baseRef: "main" })).toBe("New worktree");
  expect(envModeLabel({ type: "existing_worktree", worktreePath: "/w" })).toBe("Current worktree");
  expect(lockedEnvModeLabel(true)).toBe("Worktree");
  expect(lockedEnvModeLabel(false)).toBe("Local checkout");
  expect(branchTriggerLabel({ type: "root" })).toBe("Select ref");
  expect(branchTriggerLabel({ type: "root", branch: "dev" })).toBe("dev");
  expect(branchTriggerLabel({ type: "worktree", baseRef: "main" })).toBe("From main");
});

test("the previous worktree is the newest other thread's worktree, labelled with its branch", () => {
  const threads = [{ path: "/wt/a", updatedAt: 3 }, { path: "/wt/b", updatedAt: 9 }, { updatedAt: 20 }, { path: "/wt/c", updatedAt: 5 }];
  expect(resolvePreviousWorktreeSeed({ threads, currentWorktreePath: null, branchOf: (path) => (path === "/wt/b" ? "feature/b" : null) })).toEqual({ branch: "feature/b", worktreePath: "/wt/b" });
  expect(resolvePreviousWorktreeSeed({ threads, currentWorktreePath: "/wt/b" })?.worktreePath).toBe("/wt/c");
  expect(resolvePreviousWorktreeSeed({ threads: [{ updatedAt: 1 }], currentWorktreePath: null })).toBe(null);
  expect(previousWorktreeLabel({ branch: "feature/b", worktreePath: "/wt/b" })).toBe("Previous worktree (feature/b)");
  expect(previousWorktreeLabel({ branch: null, worktreePath: "/wt/b" })).toBe("Previous worktree");
});
