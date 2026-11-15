import { mountGitFlow } from "./GitFlowFixtureLib";

// Behind its upstream: the quick action is Pull.
mountGitFlow({
  local: { isRepo: true, hasPrimaryRemote: true, isDefaultRef: false, refName: "feature", hasWorkingTreeChanges: false, workingTree: { files: [], insertions: 0, deletions: 0 } },
  remote: { hasUpstream: true, aheadCount: 0, behindCount: 3, pr: null },
});
