import { mount, signal, Text, View } from "nsh";
import { PullRequestSummaryTab } from "./PullRequestSummaryTab";
import { parseActivity, parseDetail } from "./pullRequestDetail.logic";
import type { PullRequestDetailModel } from "./pullRequestDetailModel";

const number = signal(1);
const actionsLog = signal<string[]>([]);
const detail = () => ({ ...parseDetail({ projectId: "p", repository: "o/r", number: number(), title: "Title", url: `https://example.com/pull/${number()}`, body: `Description ${number()}`, state: "open", headBranch: "branch", baseBranch: "main", checks: [{ name: "Build", status: "failure", url: "https://example.com/check" }, { name: "No link", status: "success" }], capabilities: { actions: [], mergeMethods: [], reviewers: {} } }), canEditTitle: true });
const activity = parseActivity({ comments: [], commits: [], reviewThreads: [] });
const model = { activity: () => activity, activityError: () => null, actions: { pending: () => null, completion: () => null } } as unknown as PullRequestDetailModel;
mount(() => <View class="flex-1"><View role="button" accessibilityLabel="Switch pull request" onPress={() => number.set(2)}><Text>Switch</Text></View><Text>{`Actions: ${actionsLog().join(",")}`}</Text><PullRequestSummaryTab detail={detail} model={model} now={() => 0} onOpenLink={() => actionsLog.update((log) => [...log, "link"])} onFixFinding={() => actionsLog.update((log) => [...log, "fix"])} /></View>);
