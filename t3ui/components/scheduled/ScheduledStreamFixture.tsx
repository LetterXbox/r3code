import { mount, Text, View } from "nsh";
import { ScheduledTasks } from "./ScheduledTasks";

let attempts = 0;
let oldReceive: ((value: unknown) => void) | null = null;
const task = (title: string) => ({ id: "task-1", title, prompt: "Check changes", enabled: true,
  schedule: { type: "interval", everyMs: 60000 }, projectId: "project-1", threadId: null,
  workspaceStrategy: { type: "root" }, modelSelection: { instanceId: "codex", model: "example" },
  runtimeMode: "approval-required", interactionMode: "default", nextRunAt: null, lastRunStatus: "never", lastRunError: null });

mount(() => <View class="flex-1 gap-3">
  <View accessibilityLabel="Emit stale task result" onPress={() => oldReceive?.({ tasks: [task("Stale task")] })}><Text>Emit stale result</Text></View>
  <ScheduledTasks visible={() => true} connected={() => true} subscribe={(_method, _payload, receive, reject) => {
    attempts++;
    if (attempts === 1) { oldReceive = receive; reject(new Error("Task stream ended")); }
    else receive({ tasks: [task("Fresh task")] });
    return () => {};
  }} />
</View>);
