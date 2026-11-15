import { mount, signal, Text, View } from "nsh";
import { BranchSelector } from "./BranchSelector";
import type { BranchChange } from "./BranchSelector";

const refs = [
  { name: "main", current: true, isDefault: true, isRemote: false, worktreePath: "/work/app" },
  { name: "feature/queue", current: false, isDefault: false, isRemote: false, worktreePath: null },
  { name: "broken", current: false, isDefault: false, isRemote: false, worktreePath: null },
  { name: "origin/feature/queue", current: false, isDefault: false, isRemote: true, worktreePath: null },
];
const log = signal<string[]>([]);
const changed = signal<BranchChange | null>(null);
const current = signal("main");

async function request(method: string, payload: unknown) {
  const body = payload as { refName?: string; query?: string };
  log.set([...log(), `${method}:${body.refName ?? body.query ?? ""}`]);
  if (method === "vcs.listRefs") {
    const query = body.query?.toLowerCase();
    return { isRepo: true, hasPrimaryRemote: true, nextCursor: null, totalCount: refs.length, refs: refs.map((ref) => ({ ...ref, current: ref.name === current() })).filter((ref) => !query || ref.name.includes(query)) };
  }
  await new Promise((resolve) => setTimeout(resolve, 80));
  if (method === "vcs.switchRef") {
    if (body.refName === "broken") throw new Error("Your local changes would be overwritten.");
    current.set(body.refName ?? current());
    return { refName: body.refName };
  }
  if (method === "vcs.createRef") { current.set(body.refName ?? current()); return { refName: body.refName }; }
  return {};
}

function Fixture() {
  return (
    <View class="w-[500px] items-end">
      <BranchSelector
        cwd={() => "/work/app"}
        projectCwd={() => "/work/app"}
        activeWorktreePath={() => null}
        branch={() => changed()?.branch ?? "main"}
        selectingWorktreeBase={() => false}
        canCreate={() => true}
        disabled={() => false}
        request={request}
        onSelectBase={() => {}}
        onBranchChanged={(change) => changed.set(change)}
      />
      <Text>{`log:${log().join(",")}`}</Text>
      <Text>{`changed:${changed()?.branch ?? "none"}`}</Text>
    </View>
  );
}
mount(Fixture);
