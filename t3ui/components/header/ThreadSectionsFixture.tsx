// The Servers and Automations sections on their own, over a scripted server, with what they open recorded.
import { mount, signal, Text, View } from "nsh";
import { ConfirmDialogHost } from "../toast";
import { ToastHost } from "../toast";
import { ThreadAutomations, ThreadServers } from "./ThreadDetailsSections";
import type { Request, Subscribe } from "./gitRuntime";

const log = signal<string[]>([]);
const record = (entry: string) => log.update((all) => [...all, entry]);
const task = (id: string, title: string, schedule: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id, title, prompt: "p", enabled: true, schedule, projectId: "project-1", threadId: "thread-1", workspaceStrategy: {}, modelSelection: {}, runtimeMode: "x", interactionMode: "x", updatedAt: null, nextRunAt: null, lastRunStatus: "never", lastRunError: null, blockedByPolicy: null, ...extra });

const subscribe: Subscribe = (method, _payload, onValue) => {
  if (method === "subscribeDiscoveredLocalServers") onValue({ servers: [{ host: "localhost", port: 3000, url: "http://localhost:3000", processName: "vite", pid: 42, terminal: { threadId: "thread-1", terminalId: "t" } }] });
  if (method === "scheduledTasks.subscribe") onValue({ tasks: [task("daily", "Nightly sweep", { type: "daily", time: "09:00" }), task("hook", "On push", { type: "webhook" }), task("busy", "Running now", { type: "daily", time: "10:00" }, { lastRunStatus: "running" })] });
  return () => {};
};
const request: Request = async (method, payload) => {
  record(`request:${method}:${JSON.stringify(payload)}`);
  if (method === "scheduledTasks.setEnabled") throw new Error("server said no");
  return undefined;
};

mount(() => (
  <View class="flex-1">
    <Text>{log().join("|")}</Text>
    <ConfirmDialogHost />
    <ToastHost />
    <ThreadServers
      threadId={() => "thread-1"} subscribe={subscribe} request={request} canStop={() => false}
      openPreview={(url) => { if (url.includes("3000")) record(`preview:${url}`); }}
      openExternal={(url) => { record(`external:${url}`); throw new Error("no browser"); }}
    />
    <ThreadAutomations threadId={() => "thread-1"} subscribe={subscribe} request={request} onOpenTasks={(taskId) => record(`tasks:${taskId ?? "all"}`)} />
  </View>
));
