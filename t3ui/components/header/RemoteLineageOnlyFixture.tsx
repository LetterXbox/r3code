import { mount, signal, View } from "nsh";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import type { Request, Subscribe } from "./gitRuntime";

const open = signal(true);
const request: Request = async (method) => {
  if (method === "server.getConfig") return { availableEditors: [], environment: { label: "Local", platform: { os: "darwin", arch: "arm64", machine: "mac" }, capabilities: {} } };
  if (method === "orchestration.getThreadProjection") return {
    providerSessions: [], providerThreads: [], runs: [],
    subagents: [
      { id: "remote-a", threadId: "parent", status: "completed", title: "First remote", childThreadId: null, remoteChild: { environmentId: "env", threadId: "child-a", label: "Build host" } },
      { id: "remote-b", threadId: "parent", status: "completed", title: "Second remote", childThreadId: null, remoteChild: { environmentId: "env", threadId: "child-b", label: "Build host" } },
    ],
  };
  return undefined;
};
const subscribe: Subscribe = () => () => {};

mount(() => <View class="flex-1"><ThreadDetailsCard
  thread={() => ({ id: "parent", title: "Parent", projectId: "p" })}
  threads={() => []} open={open} cwd={() => "/folder"} threadId={() => "parent"}
  onClose={() => open.set(false)} subscribe={subscribe} request={request} scripts={() => []} projectId={() => "p"}
/></View>);
