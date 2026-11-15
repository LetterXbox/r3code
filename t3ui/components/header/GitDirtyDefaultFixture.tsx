import { mountGitFlow } from "./GitFlowFixtureLib";

// On the default ref with uncommitted changes: Commit & push asks first and may take a feature branch.
mountGitFlow({
  local: { isRepo: true, hasPrimaryRemote: true, isDefaultRef: true, refName: "main", hasWorkingTreeChanges: true, workingTree: { files: [{ path: "a.ts", insertions: 1, deletions: 0 }], insertions: 1, deletions: 0 }, sourceControlProvider: { kind: "github" } },
  remote: { hasUpstream: true, aheadCount: 0, behindCount: 0, pr: null },
});
