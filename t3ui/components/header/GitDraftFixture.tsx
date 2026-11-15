// A draft: the card hosts the run-context row and the branch picker, and hides what only a started thread has.
import { mount, signal, Text, View } from "nsh";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import type { Request, Subscribe } from "./gitRuntime";

const log = signal<string[]>([]);
const subscribe: Subscribe = (method, _payload, onValue) => {
  if (method === "subscribeVcsStatus") onValue({ _tag: "snapshot", local: { isRepo: true, hasPrimaryRemote: true, isDefaultRef: false, refName: "feature", hasWorkingTreeChanges: false, workingTree: { files: [], insertions: 0, deletions: 0 } }, remote: { hasUpstream: true, aheadCount: 0, behindCount: 0, pr: null } });
  log.update((all) => [...all, `subscribe:${method}`]);
  return () => {};
};
const request: Request = async (method, payload) => {
  log.update((all) => [...all, `request:${method}`]);
  if (method === "vcs.listRefs") return { refs: [{ name: "feature", current: true, isDefault: false, worktreePath: null }, { name: "main", current: false, isDefault: true, worktreePath: null }], isRepo: true, nextCursor: null, totalCount: 2 };
  void payload;
  return undefined;
};
mount(() => (
  <View class="flex-1">
    <Text>{log().join("|")}</Text>
    <ThreadDetailsCard thread={() => ({ id: "draft-1", title: "New thread", projectId: "p" })} isDraft={() => true} open={() => true} cwd={() => "/repo"} projectId={() => "p"} subscribe={subscribe} request={request} scripts={() => null} />
  </View>
));
