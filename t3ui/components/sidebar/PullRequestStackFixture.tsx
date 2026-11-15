// Rows whose pull request badges come from contract-shaped shell links through threadMetaFromShell.
import { mount, View } from "nsh";
import { SidebarThreadRow } from "../SidebarThreadRow";
import type { Thread } from "../../store";
import { threadMetaFromShell } from "./threadMeta";

const link = (number: number, head: string, base: string, extra: Record<string, unknown> = {}, state = "open", isDraft = false) => ({
  host: "github.com", repository: "o/r", number, url: `https://github.com/o/r/pull/${number}`, source: "agent", linkedAt: `2026-01-0${number}T00:00:00Z`,
  snapshot: { state, title: `PR ${number}`, isDraft, headBranch: head, baseBranch: base, additions: 1, deletions: 0, changedFiles: 1, checksState: null, reviewDecision: null },
  watching: false, stack: null, ...extra,
});
const row = (id: string, title: string, pullRequests: unknown[]): Thread => ({
  id, projectId: "p", title, status: "idle", pinned: true, updatedAt: Date.now() - 60_000,
  meta: threadMetaFromShell({ status: "idle", branch: "feat", pullRequests }),
});

const threads = [
  // Three pull requests, each based on the previous one's branch: one chain, so a stack.
  row("stack", "Stacked work", [link(1, "a", "main"), link(2, "b", "a"), link(3, "c", "b", {}, "merged")]),
  // Two unrelated pull requests: the newest with one more linked.
  row("many", "Two PRs", [link(4, "d", "main"), link(5, "e", "main", {}, "closed")]),
  row("one", "One PR", [link(6, "f", "main")]),
  // A stack the user dismissed down to one visible link reads as that pull request.
  row("dismissed", "Dismissed", [link(7, "g", "main"), link(8, "h", "g", { source: "stack-dismissed" })]),
];

mount(() => (
  <View class="w-[256px] gap-px bg-sidebar p-2">
    {threads.map((thread) => <SidebarThreadRow thread={thread} variant="card" active={false} projectName="Demo" onPress={() => {}} />)}
  </View>
));
