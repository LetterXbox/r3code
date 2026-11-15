// A details card over a scripted server for the Git flows: default-ref confirmation, publish and pull. Each
// fixture names the status it starts from; the log shows every request and stacked action the card sent.
import { mount, signal, Text, View } from "nsh";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { ConfirmDialogHost } from "../toast";
import { setSourceControlScopesForTest } from "./sourceControlScope";
import type { Request, Subscribe } from "./gitRuntime";

export interface GitFlowScenario {
  local: Record<string, unknown>;
  remote: Record<string, unknown>;
  discovery?: unknown;
  writeAllowed?: boolean;
  thread?: Record<string, unknown>;
}

export function mountGitFlow(scenario: GitFlowScenario) {
  const log = signal<string[]>([]);
  const open = signal(true);
  if (scenario.writeAllowed === false) setSourceControlScopesForTest({ sourceControlWrite: false });
  const subscribe: Subscribe = (method, payload, onValue) => {
    const body = payload as Record<string, unknown>;
    log.update((all) => [...all, `subscribe:${method}:${typeof body.action === "string" ? `${body.action}:${body.featureBranch === true ? "feature" : "here"}` : ""}`]);
    if (method === "subscribeVcsStatus") onValue({ _tag: "snapshot", local: scenario.local, remote: scenario.remote });
    else if (method === "git.runStackedAction") {
      const actionId = String(body.actionId);
      setTimeout(() => onValue({ actionId, kind: "action_finished", result: { toast: { title: "Pushed", description: "Pushed to origin" }, pr: { status: body.action === "create_pr" ? "created" : "skipped" }, branch: { status: "created", name: "feature/new" } } }), 50);
    }
    return () => {};
  };
  const request: Request = async (method, payload) => {
    log.update((all) => [...all, `request:${method}:${JSON.stringify(payload)}`]);
    if (method === "server.getConfig") return { availableEditors: [], environment: { label: "Box", platform: { os: "darwin", arch: "arm64", machine: "laptop" }, capabilities: {} } };
    if (method === "vcs.listRefs") return { refs: [], isRepo: true, hasPrimaryRemote: true, nextCursor: null, totalCount: 0 };
    if (method === "server.discoverSourceControl") return scenario.discovery ?? { versionControlSystems: [], sourceControlProviders: [] };
    if (method === "vcs.pull") return { status: "pulled", refName: "feature", upstreamRef: "origin/feature" };
    if (method === "sourceControl.publishRepository") return { repository: { provider: "github", nameWithOwner: "me/app", url: "https://github.com/me/app", sshUrl: "git@github.com:me/app.git" }, remoteName: "origin", remoteUrl: "git@github.com:me/app.git", branch: "main", status: "pushed" };
    return undefined;
  };
  mount(() => (
    <View class="flex-1">
      <Text>{log().join("|")}</Text>
      <ConfirmDialogHost />
      <ThreadDetailsCard
        thread={() => ({ id: "thread-1", title: "Work", ...(scenario.thread ?? {}) })}
        open={open} cwd={() => "/repo"} threadId={() => "thread-1"} onClose={() => open.set(false)} subscribe={subscribe} request={request}
      />
    </View>
  ));
}
