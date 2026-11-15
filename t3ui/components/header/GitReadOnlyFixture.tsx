import { mountGitFlow } from "./GitFlowFixtureLib";

// A connection without source-control:write.
mountGitFlow({
  local: { isRepo: true, hasPrimaryRemote: true, isDefaultRef: false, refName: "feature", hasWorkingTreeChanges: true, workingTree: { files: [{ path: "a.ts", insertions: 1, deletions: 0 }], insertions: 1, deletions: 0 } },
  remote: { hasUpstream: true, aheadCount: 0, behindCount: 0, pr: null },
  writeAllowed: false,
});
