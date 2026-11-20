import { mount, signal, Text, View } from "nsh";
import {
  applyShellEventForTest,
  openThread,
  setBackendStatusForTest,
  setRequestBackendForTest,
} from "./store";
import { Sidebar } from "./components/Sidebar";

const creations = signal(0);
setBackendStatusForTest("connected", "ws://127.0.0.1:3773/ws");
setRequestBackendForTest(async (method, input) => {
  const command = input as { type?: string; projectId?: string; title?: string; workspaceRoot?: string };
  if (method === "projects.mutate" && command.type === "project.create") {
    creations.update((count) => count + 1);
    applyShellEventForTest({
      kind: "project.updated",
      project: { id: command.projectId, title: command.title, workspaceRoot: command.workspaceRoot },
    });
  }
  return {};
});

mount(() => (
  <View class="flex-1 flex-row">
    <Sidebar />
    <Text>{openThread()?.projectId ? "Project draft opened" : "No project draft"}</Text>
    <Text>{`Projects created: ${creations()}`}</Text>
  </View>
));
