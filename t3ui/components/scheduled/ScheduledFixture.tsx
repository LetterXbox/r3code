import { mount, signal, Text, View } from "nsh";
import { ToastHost } from "../toast";
import { ScheduledTaskList } from "./ScheduledTasks";
import { readScheduledTasks } from "./data";

const tasks = signal(readScheduledTasks({ tasks: [{
  id: "task-1", title: "Review", prompt: "Check changes", enabled: true,
  schedule: { type: "interval", everyMs: 900000 }, projectId: "project-1", threadId: null,
  workspaceStrategy: { type: "root" }, modelSelection: { instanceId: "codex", model: "example" },
  runtimeMode: "approval-required", interactionMode: "default", nextRunAt: null, lastRunStatus: "never", lastRunError: null,
}] }));
const result = signal("");
const failNext = signal(false);
const editing = signal<string | null>(null);

mount(() => <View class="flex-1 gap-4">
  <View accessibilityLabel="Fail task action" onPress={() => failNext.set(true)}><Text>Fail task action</Text></View>
  <View accessibilityLabel="Close task editor" onPress={() => editing.set(null)}><Text>Close task editor</Text></View>
  <ToastHost />
  <Text>{result()}</Text>
  <ScheduledTaskList tasks={tasks()} editingId={editing()} onEdit={(task) => { result.set(`edit:${task.id}`); editing.set(task.id); }} onAction={async (operation, task) => {
    if (failNext()) { failNext.set(false); throw new Error("Permission denied"); }
    result.set(`${operation}:${task.id}`);
    if (operation === "toggle") tasks.update((all) => all.map((item) => item.id === task.id ? { ...item, enabled: !item.enabled } : item));
    if (operation === "delete") tasks.update((all) => all.filter((item) => item.id !== task.id));
  }} />
</View>);
