// Fixture for pullRequestCodeContext.test.tsx: the Code tab over one file whose two hunks leave 30 unchanged lines
// between them, and pullRequests.diffFileContents answering with its two texts (PullRequestDiffFileContentsResult).
import { mount, signal, Text, View } from "nsh";
import { PullRequestCodeTab } from "./PullRequestCodeTab";
import { createPullRequestCodeModel } from "./pullRequestCodeModel";
import { createPullRequestReviewModel } from "./pullRequestReviewModel";
import { createPullRequestActionsModel } from "./pullRequestActionsModel";
import { parseActivity, parseDetail } from "./pullRequestDetail.logic";

const oldLines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`);
const newLines = [...oldLines.slice(0, 5), "LINE 6", ...oldLines.slice(6)];
const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts",
  "@@ -3,7 +3,7 @@", " line 3", " line 4", " line 5", "-line 6", "+LINE 6", " line 7", " line 8", " line 9",
  "@@ -40,3 +40,3 @@", " line 40", "-line 41", "+line 41", " line 42", "",
].join("\n");
const DETAIL = parseDetail({
  projectId: "p", repository: "o/r", number: 7, title: "T", url: "https://github.com/o/r/pull/7", state: "open", headBranch: "h", baseBranch: "main",
  capabilities: { diff: true, comment: true, actions: [], mergeMethods: [], review: { inlineComment: true, reply: true, resolve: true }, reviewers: {} },
  viewerPermissions: { comment: true },
});
const ACTIVITY = parseActivity({ comments: [], commentCount: 0, commits: [], reviewThreads: [] });
const requests = signal<string[]>([]);
const ref = () => ({ projectId: "p", repository: "o/r", number: 7 });
async function request(method: string, payload: unknown): Promise<unknown> {
  if (method === "pullRequests.diffFileContents") {
    const input = payload as Record<string, unknown>;
    requests.update((all) => [...all, `${input.repository} ${input.number} ${input.changeType} ${input.oldPath} ${input.newPath}`]);
    return { oldContents: `${oldLines.join("\n")}\n`, newContents: `${newLines.join("\n")}\n` };
  }
  return { files: [], truncated: false };
}
const fetchStub = (async () => ({ ok: true, json: async () => ({ patch: PATCH, truncated: false, nextCursor: null }) })) as unknown as typeof fetch;
const code = createPullRequestCodeModel({ request, ref, active: () => true, http: { endpoint: () => "ws://127.0.0.1:1/", bearer: () => "tok", fetch: fetchStub } });
const review = createPullRequestReviewModel({ ref, patch: () => code.patch(), detail: () => DETAIL, activity: () => ACTIVITY, commit: () => code.commit() });
const actions = createPullRequestActionsModel({ request, ref, refresh: async () => {}, allowedMethods: () => [] });

mount(() => <View class="flex-1 flex-row">
  <View class="w-40"><Text accessibilityLabel="Content requests">{requests().join("|")}</Text></View>
  <PullRequestCodeTab code={code} review={review} actions={actions} now={() => Date.parse("2026-01-03T00:00:00Z")} provider="github" url="https://github.com/o/r/pull/7" number={7} commits={() => []} onOpenHost={() => {}} />
</View>);
