import { mountGitFlow } from "./GitFlowFixtureLib";

// A repository with no remote: the quick action is Publish repository.
mountGitFlow({
  local: { isRepo: true, hasPrimaryRemote: false, isDefaultRef: false, refName: "main", hasWorkingTreeChanges: false, workingTree: { files: [], insertions: 0, deletions: 0 } },
  remote: { hasUpstream: false, aheadCount: 0, behindCount: 0, pr: null },
  discovery: {
    versionControlSystems: [],
    sourceControlProviders: [
      { kind: "github", label: "GitHub", status: "available", installHint: "", auth: { status: "authenticated", account: "me", host: "github.com", detail: null } },
      { kind: "gitlab", label: "GitLab", status: "missing", installHint: "Install glab to use GitLab.", auth: { status: "unknown", account: null, host: null, detail: null } },
    ],
  },
});
