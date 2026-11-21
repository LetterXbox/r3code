import { expect, test } from "nsh/test";
import {
  branchOptions, buildMenuItems, changeRequestIconName, quickActionIconName, commitSelection, formatDiffCount, localBranchName, toggleExcluded, mergeVcsStatus, menuItemDisabledReason, readVcsStatus, resolveChangesTotals, resolveQuickAction,
  type VcsStatus,
} from "./gitLogic";

const base: VcsStatus = {
  isRepo: true, sourceControlProviderKind: "github", hasPrimaryRemote: true, isDefaultRef: false, refName: "feature",
  hasWorkingTreeChanges: false, workingTree: { insertions: 0, deletions: 0 }, branchChanges: null, hasUpstream: true,
  aheadCount: 0, behindCount: 0, aheadOfDefaultCount: null, pr: null,
};

test("quick action follows the web's decision table", () => {
  expect(resolveQuickAction({ ...base, hasWorkingTreeChanges: true }, false).label).toBe("Commit, push & PR");
  expect(resolveQuickAction({ ...base, hasWorkingTreeChanges: true }, false).action).toBe("commit_push_pr");
  expect(resolveQuickAction({ ...base, hasWorkingTreeChanges: true, behindCount: 1 }, false).action).toBe("commit");
  expect(resolveQuickAction({ ...base, hasWorkingTreeChanges: true }, false, true).label).toBe("Commit & push");
  expect(resolveQuickAction({ ...base, aheadCount: 2 }, false).label).toBe("Push & create PR");
  expect(resolveQuickAction({ ...base, aheadCount: 2, pr: { number: 1, title: "t", url: "u", state: "open" } }, false).label).toBe("Push");
  expect(resolveQuickAction({ ...base, behindCount: 2 }, false).kind).toBe("run_pull");
  expect(resolveQuickAction({ ...base, aheadCount: 1, behindCount: 1 }, false).label).toBe("Sync ref");
  expect(resolveQuickAction({ ...base, hasUpstream: false }, false).hint).toBe("No local commits to push.");
  expect(resolveQuickAction({ ...base, hasUpstream: false, hasPrimaryRemote: false }, false, false, false).kind).toBe("open_publish");
  expect(resolveQuickAction({ ...base, refName: null }, false).disabled).toBe(true);
  expect(resolveQuickAction(base, true).hint).toBe("Git action in progress.");
  expect(resolveQuickAction(null, false).hint).toBe("Git status is unavailable.");
  expect(resolveQuickAction({ ...base, sourceControlProviderKind: "gitlab", aheadCount: 1 }, false).label).toBe("Push & create MR");
});

test("dropdown lists commit, push and create PR with the web's enabling rules", () => {
  const dirty = buildMenuItems({ ...base, hasWorkingTreeChanges: true, aheadCount: 1 }, false);
  expect(dirty.map((item) => [item.label, item.disabled])).toEqual([["Commit", false], ["Push", false], ["Create PR", false]]);
  const clean = buildMenuItems(base, false);
  expect(clean.every((item) => item.disabled)).toBe(true);
  expect(menuItemDisabledReason(clean[0]!, base, false)).toBe("Worktree is clean. Make changes before committing.");
  expect(menuItemDisabledReason(clean[1]!, base, false)).toBe("No local commits to push.");
  expect(buildMenuItems({ ...base, pr: { number: 1, title: "t", url: "u", state: "open" } }, false).length).toBe(2);
  expect(buildMenuItems(base, false, false).map((item) => item.id)).toEqual(["commit"]);
  expect(buildMenuItems(null, false)).toEqual([]);
});

test("changes totals do not let a zero branch total hide a dirty tree", () => {
  const dirty = { ...base, workingTree: { insertions: 3, deletions: 1, files: [{ path: "src/app.ts", insertions: 3, deletions: 1 }] }, branchChanges: { baseRef: "main", insertions: 0, deletions: 0 } };
  expect(resolveChangesTotals(dirty)).toEqual({ insertions: 3, deletions: 1, baseRef: null, breakdown: { code: { additions: 3, deletions: 1 }, tests: { additions: 0, deletions: 0 }, mocks: { additions: 0, deletions: 0 }, generated: { additions: 0, deletions: 0 }, docs: { additions: 0, deletions: 0 } } });
  expect(resolveChangesTotals({ ...dirty, branchChanges: { baseRef: "main", insertions: 5, deletions: 2 } })).toEqual({ insertions: 5, deletions: 2, baseRef: "main", breakdown: null });
  expect(resolveChangesTotals(null)).toBe(null);
  expect(formatDiffCount(999)).toBe("999");
  expect(formatDiffCount(1500)).toBe("1,500");
  expect(formatDiffCount(1234567)).toBe("1,234,567");
});

test("status stream events merge into one status", () => {
  const snapshot = mergeVcsStatus({ local: null, remote: null }, {
    _tag: "snapshot",
    local: { isRepo: true, hasPrimaryRemote: true, isDefaultRef: false, refName: "main", hasWorkingTreeChanges: true, workingTree: { files: [], insertions: 2, deletions: 1 } },
    remote: null,
  });
  expect(readVcsStatus(snapshot)?.hasWorkingTreeChanges).toBe(true);
  const withRemote = mergeVcsStatus(snapshot, { _tag: "remoteUpdated", remote: { hasUpstream: true, aheadCount: 2, behindCount: 0, pr: { number: 7, title: "T", url: "https://x/7", state: "open" } } });
  const status = readVcsStatus(withRemote);
  expect(status?.aheadCount).toBe(2);
  expect(status?.pr?.number).toBe(7);
  expect(readVcsStatus({ local: null, remote: null })).toBe(null);
});

test("the commit dialog commits every file unless some are unchecked", () => {
  const files = [{ path: "a.ts", insertions: 2, deletions: 1 }, { path: "b.ts", insertions: 5, deletions: 0 }];
  const all = commitSelection(files, new Set());
  expect(all.filePaths).toBeNull();
  expect(all.insertions).toBe(7);
  const some = commitSelection(files, toggleExcluded(new Set(), "a.ts"));
  expect(some.filePaths).toEqual(["b.ts"]);
  expect(some.insertions).toBe(5);
  expect(some.deletions).toBe(0);
  expect(commitSelection(files, new Set(["a.ts", "b.ts"])).noneSelected).toBe(true);
  expect(toggleExcluded(new Set(["a.ts"]), "a.ts").size).toBe(0);
});

test("the branch picker lists local branches first and checks a remote ref out under its local name", () => {
  expect(localBranchName({ name: "origin/feature/x", isRemote: true, remoteName: "origin" })).toBe("feature/x");
  expect(localBranchName({ name: "main" })).toBe("main");
  const options = branchOptions([
    { name: "origin/dev", isRemote: true, remoteName: "origin", current: false },
    { name: "main", current: true },
    { name: "origin/main", isRemote: true, remoteName: "origin", current: false },
  ]);
  expect(options.map((option) => option.value)).toEqual(["main", "origin/dev"]);
  expect(options[0]?.current).toBe(true);
});

test("the status carries the changed files", () => {
  const status = readVcsStatus({ local: { isRepo: true, workingTree: { insertions: 1, deletions: 0, files: [{ path: "a.ts", insertions: 1, deletions: 0 }, { nope: 1 }] } }, remote: null });
  expect(status?.workingTree.files).toEqual([{ path: "a.ts", insertions: 1, deletions: 0 }]);
});

test("the create-PR icon follows the host: GitHub's mark, else the pull request glyph", () => {
  expect(changeRequestIconName("github")).toBe("github");
  for (const kind of ["gitlab", "bitbucket", "azure-devops", "forgejo", "gitcafe", "cursor-origin"]) expect(changeRequestIconName(kind)).toBe(`host-${kind}`);
  expect(changeRequestIconName("unknown-host")).toBe("git-pull-request-arrow");
  expect(changeRequestIconName(null)).toBe("git-pull-request-arrow");
  expect(quickActionIconName({ kind: "run_action", action: "create_pr", label: "Push & create PR" }, "github")).toBe("github");
  expect(quickActionIconName({ kind: "run_action", action: "push", label: "Push" }, "github")).toBe("cloud-upload");
  expect(quickActionIconName({ kind: "run_action", action: "commit", label: "Commit" }, "github")).toBe("git-commit-horizontal");
  expect(quickActionIconName({ kind: "run_pull", label: "Pull" }, "github")).toBe("cloud-download");
});
