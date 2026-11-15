import { mount, signal, Text, View } from "nsh";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import type { Request, Subscribe } from "./gitRuntime";

// A shell push rebuilds the objects the cwd is read from; the folder string stays the same.
const pushes = signal(0);
const folder = signal("/repo");
const count = signal(0);
const subscribe: Subscribe = (method) => {
  if (method === "subscribeVcsStatus") count.update((n) => n + 1);
  return () => {};
};
const request: Request = async () => undefined;

mount(() => (
  <View class="flex-1">
    <Text>{`vcs subscribes: ${count()}`}</Text>
    <View role="button" accessibilityLabel="Push shell" onPress={() => pushes.update((n) => n + 1)}><Text>Push shell</Text></View>
    <View role="button" accessibilityLabel="Change folder" onPress={() => folder.set("/other")}><Text>Change folder</Text></View>
    <ThreadDetailsCard thread={() => ({ id: "thread-1", title: "Work" })} threads={() => []} open={() => false}
      cwd={() => ({ path: folder(), push: pushes() }).path} threadId={() => "thread-1"} onClose={() => {}} onOpenChanges={() => {}}
      subscribe={subscribe} request={request} projectId={() => "project-1"} />
  </View>
));
