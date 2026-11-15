import { mount, signal, Text, View } from "nsh";
import { BranchSelector } from "./BranchSelector";
import { EnvModeSelector } from "./EnvModeSelector";
import type { WorkspaceStrategy } from "../../store";

const strategy = signal<WorkspaceStrategy>({ type: "root" });
const locked = signal(false);
const log = signal<string[]>([]);
const note = (text: string) => log.update((all) => [...all, text]);

async function request(method: string, payload: unknown) {
  const body = payload as { query?: string };
  if (method === "vcs.listRefs") {
    const query = body.query?.toLowerCase();
    const refs = [
      { name: "main", current: true, isDefault: true, isRemote: false, worktreePath: null },
      { name: "feature/b", current: false, isDefault: false, isRemote: false, worktreePath: "/wt/b" },
    ];
    return { isRepo: true, nextCursor: null, totalCount: refs.length, refs: refs.filter((ref) => !query || ref.name.includes(query)) };
  }
  return {};
}

function describe(next: WorkspaceStrategy): string {
  return next.type === "worktree" ? `worktree:${next.baseRef}:${next.startFromOrigin === true}` : next.type === "existing_worktree" ? `existing:${next.worktreePath}` : "root";
}

function Fixture() {
  const current = () => strategy();
  return (
    <View class="w-[520px]">
      <View class="flex-row items-center gap-2">
        <EnvModeSelector
          strategy={current}
          locked={() => locked()}
          lockedWorktree={() => false}
          activeWorktreePath={() => (current().type === "existing_worktree" ? (current() as { worktreePath: string }).worktreePath : null)}
          disabled={() => false}
          projectPath={() => "/work/app"}
          seed={() => (current().type === "existing_worktree" ? null : { branch: "feature/b", worktreePath: "/wt/b" })}
          onSelect={(next) => { strategy.set(next as WorkspaceStrategy); note(`select:${describe(next as WorkspaceStrategy)}`); }}
          onUsePrevious={() => { strategy.set({ type: "existing_worktree", worktreePath: "/wt/b", branch: "feature/b" }); note("previous:/wt/b"); }}
          request={request}
        />
        <View class="flex-1" />
        <BranchSelector
          cwd={() => "/work/app"}
          projectCwd={() => "/work/app"}
          activeWorktreePath={() => null}
          branch={() => (current().type === "worktree" ? (current() as { baseRef: string }).baseRef : "main")}
          selectingWorktreeBase={() => current().type === "worktree"}
          canCreate={() => true}
          disabled={() => false}
          request={request}
          onSelectBase={() => {}}
          onBranchChanged={() => {}}
          startFromOrigin={() => { const now = current(); return now.type === "worktree" && now.startFromOrigin === true; }}
          onStartFromOriginChange={(checked) => { const now = current(); if (now.type === "worktree") { strategy.set({ ...now, startFromOrigin: checked }); note(`origin:${checked}`); } }}
          onCheckoutPullRequest={(reference) => note(`checkout:${reference}`)}
        />
      </View>
      <Text>{`log:${log().join(",")}`}</Text>
      <View accessibilityLabel="Lock workspace" onPress={() => locked.set(true)}><Text>Lock workspace</Text></View>
    </View>
  );
}
mount(Fixture);
