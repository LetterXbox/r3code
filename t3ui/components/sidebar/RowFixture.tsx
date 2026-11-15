import { mount, View } from "nsh";
import { SidebarThreadRow } from "../SidebarThreadRow";
import { ConfirmDialogHost } from "../toast/ConfirmDialogHost";
import { ToastHost } from "../toast/ToastHost";
import { openThreadById, setComposerDraft, type Thread } from "../../store";
import type { ThreadSidebarMeta } from "./threadMeta";

const meta = (patch: Partial<ThreadSidebarMeta>): ThreadSidebarMeta => ({
  runStatus: "idle", activityRunStatus: null, pendingRequestKind: null, pendingGuestMessageCount: 0,
  blockedOnThreadWait: false, lastErrorClass: null, lastVisitedAt: null, latestRunCompletedAt: null,
  latestRunStartedAt: null, snoozedUntil: null, settled: false, hasActionableProposedPlan: false,
  branch: null, titleRegenerating: false, ...patch,
});
const make = (id: string, title: string, patch: Partial<ThreadSidebarMeta>, extra: Partial<Thread> = {}): Thread => ({
  id, projectId: "p", title, status: "idle", pinned: false, updatedAt: Date.now() - 5.5 * 60_000, meta: meta(patch), ...extra,
});

const threads = [
  make("working", "Build the thing", { runStatus: "running" }),
  make("approval", "Needs a yes", { pendingRequestKind: "approval" }),
  make("input", "Needs an answer", { pendingRequestKind: "user_input" }),
  make("done", "Finished work", { runStatus: "completed", latestRunCompletedAt: 200, lastVisitedAt: 100 }),
  make("failed", "Broken run", { runStatus: "failed" }),
  make("idle", "Quiet thread", {}),
  make("branch", "On a branch", { branch: "feat/side" }),
  make("woke", "Back again", { snoozedUntil: Date.now() - 60_000, lastVisitedAt: Date.now() - 3_600_000 }),
];

function Fixture() {
  openThreadById("draft-fixture");
  setComposerDraft("Unsent text");
  return (
    <View class="w-[256px] gap-px bg-sidebar p-2">
      <ConfirmDialogHost />
      <ToastHost />
      <SidebarThreadRow thread={make("draft-fixture", "Unsent thread", {})} variant="card" active={false} projectName="Demo" onPress={() => {}} />
      {threads.map((thread) => (
        <SidebarThreadRow thread={thread} variant="folder" active={false} projectName="Demo" projectPath="/tmp/demo" onPress={() => {}} />
      ))}
      <SidebarThreadRow thread={make("pinned", "Pinned one", {}, { pinned: true })} variant="card" active={false} projectName="Demo" onPress={() => {}} />
      <SidebarThreadRow
        thread={make("withpr", "Has a PR", { branch: "feat/pr", pullRequest: { number: 42, url: "https://example.invalid/pull/42", state: "merged" } }, { pinned: true })}
        variant="card" active={false} projectName="Demo" onPress={() => {}}
      />
      <SidebarThreadRow
        thread={make("wt", "Worktree thread", { branch: "feat/wt" }, { pinned: true, path: "/tmp/work/wt-one" })}
        variant="card" active={false} projectName="Demo" onPress={() => {}}
      />
      <SidebarThreadRow
        thread={make("snoozed", "Sleeping", { snoozedUntil: Date.now() + 2.5 * 3_600_000 })}
        variant="slim" active={false} projectName="Demo" onPress={() => {}}
      />
    </View>
  );
}

mount(Fixture);
