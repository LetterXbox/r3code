import { mountGitFlow } from "./GitFlowFixtureLib";

// On the default ref with commits to push: Push asks first.
mountGitFlow({
  local: { isRepo: true, hasPrimaryRemote: true, isDefaultRef: true, refName: "main", hasWorkingTreeChanges: false, workingTree: { files: [], insertions: 0, deletions: 0 }, sourceControlProvider: { kind: "github" } },
  remote: { hasUpstream: true, aheadCount: 2, behindCount: 0, aheadOfDefaultCount: 0, pr: null },
});
