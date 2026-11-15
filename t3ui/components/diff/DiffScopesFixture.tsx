// The diff panel's commit, turn and tool-call selections against contract-shaped server answers
// (ReviewDiffPreviewResult with a commit source, ReviewBranchCommitsResult, ThreadTurnDiff, a file_change turn item).
import { mount, signal, Text, View } from "nsh";
import { DiffPanel } from "./DiffPanel";
import { selectCommit, selectToolCall, selectTurn } from "./diffPanelStore";

const calls = signal<string[]>([]);
const patch = (path: string, line: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${line}\n`;

async function rpc(method: string, payload: unknown): Promise<unknown> {
  const input = payload as Record<string, unknown>;
  calls.update((all) => [...all, `${method}${typeof input.commitSha === "string" ? `@${input.commitSha}` : ""}${typeof input.baseRef === "string" ? `~${input.baseRef}` : ""}${input.file ? ":file" : ""}`]);
  if (method === "review.getBranchCommits") {
    return { commits: [{ sha: "abc1234def", subject: "Fix the parser", committedAt: new Date(Date.now() - 120_000).toISOString() }], truncated: false };
  }
  if (method === "vcs.listRefs") {
    return input.refKind === "local"
      ? { isRepo: true, refs: [{ name: "feature", current: true, isDefault: false, worktreePath: null }, { name: "main", current: false, isDefault: true, worktreePath: null }] }
      : { isRepo: true, refs: [{ name: "origin/main", isRemote: true, remoteName: "origin", current: false, isDefault: false, worktreePath: null }, { name: "origin/release", isRemote: true, remoteName: "origin", current: false, isDefault: false, worktreePath: null }] };
  }
  if (method === "orchestration.getTurnDiff") {
    return { threadId: input.threadId, fromTurnCount: input.fromTurnCount, toTurnCount: input.toTurnCount, diff: patch("turn/a.ts", `turn ${String(input.toTurnCount)}`) + patch("turn/b.ts", "b") };
  }
  if (method === "orchestration.getFullThreadDiff") {
    return { threadId: input.threadId, fromTurnCount: 0, toTurnCount: input.toTurnCount, diff: patch("turn/a.ts", `turn ${String(input.toTurnCount)}`) + patch("turn/b.ts", "b") };
  }
  if (method === "orchestration.getTurnItem") {
    return { item: { type: "file_change", id: "item-1", fileName: "tool.ts", diffStr: "@@ -1 +1 @@\n-old\n+tool\n", changes: [{ path: "tool.ts", operation: "update" }] } };
  }
  if (method === "review.getDiffPreview") {
    if (typeof input.commitSha === "string") {
      const file = input.file as { path: string } | undefined;
      const files = [{ path: "commit/one.ts", previousPath: null, additions: 1, deletions: 1 }];
      return { cwd: "/project", sources: [{ id: input.commitSha, kind: "commit", title: "Commit", commitSubject: "Fix the parser", baseRef: "abc1234def~1", headRef: input.commitSha, diff: file ? patch(file.path, "commit") : "", diffHash: "h", truncated: false, files }] };
    }
    const kind = input.sourceKind === "working-tree" ? "working-tree" : "branch-range";
    const file = input.file as { path: string } | undefined;
    return { cwd: "/project", sources: [{ id: kind, kind, title: "Changes", baseRef: "main", headRef: "feature", diff: file ? patch(file.path, "branch") : "", diffHash: "h", truncated: false, files: [{ path: "src/branch.ts", previousPath: null, additions: 1, deletions: 1 }] }] };
  }
  throw new Error(`Unexpected ${method}`);
}

const checkpoints = () => [
  { id: "c1", runId: "run-1", appRunOrdinal: 1, capturedAt: "2026-11-01T10:00:00.000Z", files: [] },
  { id: "c2", runId: "run-2", appRunOrdinal: 2, capturedAt: "2026-11-01T11:00:00.000Z", files: [] },
];

mount(() => <View class="flex-1 flex-row">
  <View class="w-40 gap-3">
    <View accessibilityLabel="Open turn 1 at b" onPress={() => selectTurn("thread-s", "run-1", "turn/b.ts")}><Text>turn</Text></View>
    <View accessibilityLabel="Open commit" onPress={() => selectCommit("thread-s", "abc1234def")}><Text>commit</Text></View>
    <View accessibilityLabel="Open tool call" onPress={() => selectToolCall("thread-s", { threadId: "thread-s", itemId: "item-1", revision: "r1" })}><Text>tool</Text></View>
    {calls().map((call) => <Text accessibilityLabel={`call ${call}`}>{call}</Text>)}
  </View>
  <DiffPanel threadId="thread-s" cwd="/project" request={rpc} checkpoints={checkpoints} />
</View>);
