import { mount, signal, Text, View } from "nsh";
import { applyConfigEventForTest, applyShellEventForTest, setBackendStatusForTest } from "../../store";
import { ToastHost } from "../toast";
import { TaskEditorDialog } from "./TaskEditorDialog";
import { readScheduledTasks } from "./data";

const iso = new Date().toISOString();
applyConfigEventForTest({ type: "snapshot", config: {
  environment: { environmentId: "environment-live", label: "legion", capabilities: { oneTimeSchedules: true, scheduledTaskThreadModes: true } },
  settings: {},
  providers: [{ instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, installed: true, status: "ready", availability: "available", auth: { status: "authenticated" }, models: [{ slug: "example", name: "Example", isCustom: false, capabilities: { optionDescriptors: [] } }], slashCommands: [], skills: [] }],
} });
applyShellEventForTest({ kind: "snapshot", snapshot: { projects: [{ id: "project-1", title: "Project", workspaceRoot: "/work/p", pinnedAt: null, createdAt: iso, updatedAt: iso }], threads: [] } });
setBackendStatusForTest("connected");

const result = signal("");
const saved = signal("");
const webhook = readScheduledTasks({ tasks: [{ id: "hook-1", title: "Hook", prompt: "Handle {{body}}", enabled: true, schedule: { type: "webhook", signature: null, filters: [] }, projectId: "project-1", threadId: null, workspaceStrategy: { type: "root" }, modelSelection: { instanceId: "codex", model: "example" }, runtimeMode: "approval-required", interactionMode: "default", nextRunAt: null, lastRunStatus: "never", lastRunError: null, webhook: { path: "/hooks/abc", url: "https://hooks.example/abc", hasSecret: false } }] });
const editWebhook = signal(false);
mount(() => <View class="flex-1 gap-3">
  <ToastHost />
  <View accessibilityLabel="Edit webhook fixture" onPress={() => editWebhook.set(true)}><Text>Edit webhook fixture</Text></View>
  <Text>{result()}</Text>
  <Text>{saved()}</Text>
  <TaskEditorDialog task={editWebhook() ? webhook[0]! : null} tasks={() => webhook} onClose={() => result.set("closed")}
    onSave={async (payload) => { saved.set(`saved:${payload.title}:${JSON.stringify(payload.schedule)}:${JSON.stringify(payload.threadMode ?? null)}`); }} />
</View>);
