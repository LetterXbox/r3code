import { mount, signal, Text, View } from "nsh";
import { ThreadDetailsPrRow } from "./ThreadDetailsPrRow";
import { ConfirmDialogHost } from "../toast/ConfirmDialogHost";
import type { LinkedPullRequest } from "./threadRelations";

// pullRequests.detail answers as the server sends them (PullRequestDetail), per number.
const base = {
  projectId: "p1", repository: "acme/app", url: "https://github.com/acme/app/pull/1", state: "open", isDraft: false, mergeability: "mergeable",
  additions: 12, deletions: 3, changedFiles: 2, headBranch: "feat", baseBranch: "main", provider: "github", body: "", createdAt: "", updatedAt: "",
  capabilities: { actions: ["merge", "ready"], mergeMethods: ["squash", "merge"] }, viewerPermissions: { actions: ["merge", "ready"] },
  mergeCapabilities: { merge: true, squash: true, rebase: false },
};
const details: Record<number, unknown> = {
  1: { ...base, number: 1, title: "feat: add the thing", checks: [{ name: "ci", status: "success" }, { name: "lint", status: "success" }] },
  2: { ...base, number: 2, title: "fix: failing", checks: [{ name: "ci", status: "failure" }, { name: "lint", status: "success" }, { name: "e2e", status: "pending" }] },
  3: { ...base, number: 3, title: "wip: draft", isDraft: true, checks: [] },
};
const log = signal<string[]>([]);
const request = (method: string, payload: unknown) => {
  const p = payload as { number: number; action?: string; mergeMethod?: string };
  log.update((all) => [...all, `${method}${p.action ? ` ${p.action}` : ""}${p.mergeMethod ? ` ${p.mergeMethod}` : ""}`]);
  if (method === "pullRequests.changeBreakdown") return Promise.resolve({ code: { additions: 10, deletions: 3 }, tests: { additions: 2, deletions: 0 }, mocks: { additions: 0, deletions: 0 } });
  return method === "pullRequests.detail" ? Promise.resolve(details[p.number]) : Promise.resolve({});
};
const link = (number: number, watching = false): LinkedPullRequest => ({ host: "github.com", repository: "acme/app", number, url: `https://github.com/acme/app/pull/${number}`, source: "agent", linkedAt: "", snapshot: null, watching });
const stopped = signal("");

mount(() => (
  <View class="w-[360px]">
    <ThreadDetailsPrRow link={link(1, true)} projectId="p1" label="#1: feat" request={request} onStopWatching={() => stopped.set("stopped 1")} />
    <ThreadDetailsPrRow link={link(2)} projectId="p1" label="#2: fix" request={request} />
    <ThreadDetailsPrRow link={link(3)} projectId="p1" label="#3: wip" request={request} />
    <ConfirmDialogHost />
    <Text>{`log ${log().filter((line) => !line.startsWith("pullRequests.detail") && !line.startsWith("pullRequests.changeBreakdown")).join(",")}${stopped() ? ` ${stopped()}` : ""}`}</Text>
  </View>
));
