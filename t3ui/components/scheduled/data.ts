import { record } from "../../backend/client";
import { isInteractionMode, isRuntimeMode } from "../../backend/launch";

export type Schedule =
  | { type: "interval"; everyMs: number }
  | { type: "fixed_time"; timeOfDay: string; weekdays?: number[] }
  | { type: "once"; runAt: string }
  | {
      type: "webhook";
      /** The signature the webhook requires; the secret itself is never sent back (`webhook.hasSecret` says one is stored). */
      signature?: { header: string; encoding: "hex" | "base64"; prefix: string } | null;
      maxDeliveryAgeMinutes?: number | null;
      dedupe?: { replayKey?: string; coalesceKey?: string; coalesceWindowSeconds?: number };
      filters?: WebhookFilter[];
    }
  | { type: "unknown" };

export type WebhookFilter = { path: string; op: "equals" | "notEquals" | "startsWith"; value: string } | { path: string; op: "in"; value: string[] } | { path: string; op: "exists" };
/** ScheduledTaskWebhookEndpoint: the path (and public URL when linked) the task listens on. */
export interface WebhookEndpoint { path: string; url: string | null; hasSecret: boolean }

export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  schedule: Schedule;
  projectId: string;
  threadId: string | null;
  threadMode?: string;
  workspaceStrategy: Record<string, unknown>;
  modelSelection: Record<string, unknown>;
  runtimeMode: string;
  interactionMode: string;
  updatedAt: string | null;
  nextRunAt: string | null;
  lastRunStatus: string;
  lastRunError: string | null;
  blockedByPolicy: string | null;
  webhook?: WebhookEndpoint;
}

function readFilters(value: unknown): WebhookFilter[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): WebhookFilter[] => {
    const filter = record(entry);
    if (!filter || typeof filter.path !== "string") return [];
    if (filter.op === "exists") return [{ path: filter.path, op: "exists" }];
    if (filter.op === "in" && Array.isArray(filter.value)) return [{ path: filter.path, op: "in", value: filter.value.filter((item): item is string => typeof item === "string") }];
    if ((filter.op === "equals" || filter.op === "notEquals" || filter.op === "startsWith") && typeof filter.value === "string") return [{ path: filter.path, op: filter.op, value: filter.value }];
    return [];
  });
}

function readWebhookSchedule(schedule: Record<string, unknown>): Schedule {
  const signature = record(schedule.signature);
  const dedupe = record(schedule.dedupe);
  return {
    type: "webhook",
    signature: signature && typeof signature.header === "string" ? { header: signature.header, encoding: signature.encoding === "base64" ? "base64" : "hex", prefix: typeof signature.prefix === "string" ? signature.prefix : "" } : null,
    maxDeliveryAgeMinutes: typeof schedule.maxDeliveryAgeMinutes === "number" ? schedule.maxDeliveryAgeMinutes : null,
    ...(dedupe ? { dedupe: {
      ...(typeof dedupe.replayKey === "string" ? { replayKey: dedupe.replayKey } : {}),
      ...(typeof dedupe.coalesceKey === "string" ? { coalesceKey: dedupe.coalesceKey } : {}),
      ...(typeof dedupe.coalesceWindowSeconds === "number" ? { coalesceWindowSeconds: dedupe.coalesceWindowSeconds } : {}),
    } } : {}),
    filters: readFilters(schedule.filters),
  };
}

function readSchedule(value: unknown): Schedule {
  const schedule = record(value);
  if (schedule?.type === "interval" && typeof schedule.everyMs === "number" && Number.isFinite(schedule.everyMs)) {
    return { type: "interval", everyMs: schedule.everyMs };
  }
  if (schedule?.type === "fixed_time" && typeof schedule.timeOfDay === "string") {
    const weekdays = Array.isArray(schedule.weekdays)
      ? schedule.weekdays.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6) : undefined;
    return { type: "fixed_time", timeOfDay: schedule.timeOfDay, ...(weekdays ? { weekdays } : {}) };
  }
  if (schedule?.type === "once" && typeof schedule.runAt === "string") return { type: "once", runAt: schedule.runAt };
  if (schedule?.type === "webhook") return readWebhookSchedule(schedule);
  return { type: "unknown" };
}

/** Decode each item independently so a future server field does not hide the list. */
export function readScheduledTasks(value: unknown): ScheduledTask[] {
  const envelope = record(value);
  if (!envelope || !Array.isArray(envelope.tasks)) throw new Error("The server returned an invalid task list");
  return envelope.tasks.flatMap((raw): ScheduledTask[] => {
    const task = record(raw);
    const workspaceStrategy = record(task?.workspaceStrategy);
    const modelSelection = record(task?.modelSelection);
    if (!task || typeof task.id !== "string" || typeof task.title !== "string" || typeof task.prompt !== "string" ||
        typeof task.enabled !== "boolean" || typeof task.projectId !== "string" || !workspaceStrategy || !modelSelection ||
        typeof task.runtimeMode !== "string" || typeof task.interactionMode !== "string") return [];
    return [{ id: task.id, title: task.title, prompt: task.prompt, enabled: task.enabled, schedule: readSchedule(task.schedule),
      projectId: task.projectId, threadId: typeof task.threadId === "string" ? task.threadId : null,
      ...(typeof task.threadMode === "string" ? { threadMode: task.threadMode } : {}), workspaceStrategy, modelSelection,
      runtimeMode: task.runtimeMode, interactionMode: task.interactionMode,
      updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : null,
      nextRunAt: typeof task.nextRunAt === "string" ? task.nextRunAt : null,
      lastRunStatus: typeof task.lastRunStatus === "string" ? task.lastRunStatus : "never",
      lastRunError: typeof task.lastRunError === "string" ? task.lastRunError : null,
      blockedByPolicy: typeof task.blockedByPolicy === "string" ? task.blockedByPolicy : null,
      ...(record(task.webhook) && typeof record(task.webhook)!.path === "string" ? { webhook: { path: record(task.webhook)!.path as string, url: typeof record(task.webhook)!.url === "string" ? record(task.webhook)!.url as string : null, hasSecret: record(task.webhook)!.hasSecret === true } } : {}) }];
  });
}

/** Guard edits when a newer server snapshot has changed the task. */
export function assertTaskUnchanged(original: ScheduledTask, latest: ScheduledTask | undefined): void {
  if (!latest) throw new Error("This task no longer exists. Close the editor and refresh the list.");
  const editable = (task: ScheduledTask) => JSON.stringify({
    title: task.title, prompt: task.prompt, enabled: task.enabled, schedule: task.schedule,
    projectId: task.projectId, threadId: task.threadId, threadMode: task.threadMode,
    workspaceStrategy: task.workspaceStrategy, modelSelection: task.modelSelection,
    runtimeMode: task.runtimeMode, interactionMode: task.interactionMode, updatedAt: task.updatedAt,
  });
  if (editable(original) !== editable(latest)) throw new Error("This task changed while you were editing. Close and reopen it to use the latest settings.");
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** scheduleLabel (ScheduledTasksSettings.tsx). */
export function scheduleLabel(schedule: Schedule): string {
  if (schedule.type === "webhook") return "On webhook";
  if (schedule.type === "once") {
    const date = new Date(schedule.runAt);
    return Number.isFinite(date.getTime()) ? `Once, ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)}` : "Once";
  }
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes) ? `Every ${minutes} min` : `Every ${Math.round(schedule.everyMs / 1000)} sec`;
  }
  if (schedule.type === "unknown") return "Unknown schedule";
  const weekdays = schedule.weekdays ?? [];
  const days = weekdays.length === 0 ? "Daily" : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5) ? "Weekdays" : weekdays.map((day) => DAYS[day]).join(", ");
  return `${days} at ${schedule.timeOfDay}`;
}

export interface TaskForm {
  title: string;
  prompt: string;
  enabled: boolean;
  scheduleType: "interval" | "fixed_time" | "once";
  intervalMinutes: string;
  timeOfDay: string;
  weekdays: number[];
  onceAt: string;
  projectId: string;
  modelProvider: string;
  modelId: string;
  runtimeMode: string;
  interactionMode: string;
}

/** The minute-precision local value shown by the editor. */
export function localDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export type ScheduledTaskOperation = "toggle" | "run" | "delete";
export function scheduledActionRequest(operation: ScheduledTaskOperation, task: ScheduledTask): { method: string; payload: Record<string, unknown> } {
  if (operation === "toggle") return { method: "scheduledTasks.setEnabled", payload: { id: task.id, enabled: !task.enabled } };
  if (operation === "run") return { method: "scheduledTasks.runNow", payload: { id: task.id } };
  return { method: "scheduledTasks.delete", payload: { id: task.id } };
}

/** Build only the schedule modes this client can safely edit. */
export function buildTaskInput(form: TaskForm, commandId: string, original?: ScheduledTask): Record<string, unknown> {
  const title = form.title.trim();
  const prompt = form.prompt.trim();
  if (!title || !prompt || !form.projectId || !form.modelProvider || !form.modelId) {
    throw new Error("Enter a title and prompt, then select a project and model.");
  }
  if (!isRuntimeMode(form.runtimeMode) || !isInteractionMode(form.interactionMode)) {
    throw new Error("Choose valid permissions and interaction mode.");
  }
  let schedule: Record<string, unknown>;
  if (form.scheduleType === "interval") {
    const minutes = Number(form.intervalMinutes);
    const unchanged = original?.schedule.type === "interval" && form.intervalMinutes === String(original.schedule.everyMs / 60000);
    const everyMs = unchanged && original?.schedule.type === "interval" ? original.schedule.everyMs : minutes * 60000;
    if (!Number.isSafeInteger(everyMs) || everyMs < 60000) throw new Error("Choose an interval of at least one minute.");
    schedule = { type: "interval", everyMs };
  } else if (form.scheduleType === "fixed_time") {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(form.timeOfDay)) throw new Error("Enter a daily time as HH:MM.");
    if (form.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error("Choose valid weekdays.");
    const weekdays = [...new Set(form.weekdays)].sort((a, b) => a - b);
    schedule = { type: "fixed_time", timeOfDay: form.timeOfDay,
      ...(weekdays.length > 0 && weekdays.length < 7 ? { weekdays } : {}) };
  } else {
    const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(form.onceAt);
    const date = new Date(form.onceAt);
    if (!parts || !Number.isFinite(date.getTime()) || date.getFullYear() !== Number(parts[1]) ||
        date.getMonth() + 1 !== Number(parts[2]) || date.getDate() !== Number(parts[3]) ||
        date.getHours() !== Number(parts[4]) || date.getMinutes() !== Number(parts[5])) {
      throw new Error("Enter a valid local date and time as YYYY-MM-DDTHH:MM.");
    }
    const saved = original?.schedule.type === "once" ? original.schedule.runAt : null;
    if (saved && localDateTime(saved) === form.onceAt) {
      // Editing an unrelated field must not lose seconds or change the
      // occurrence of a local hour that repeats when clocks move back.
      schedule = { type: "once", runAt: saved };
    } else {
      const previous = saved ? new Date(saved) : null;
      const sameOffset = previous && Number.isFinite(previous.getTime())
        ? new Date(Date.parse(`${form.onceAt}Z`) + previous.getTimezoneOffset() * 60000) : null;
      schedule = { type: "once", runAt: sameOffset && localDateTime(sameOffset.toISOString()) === form.onceAt
        ? sameOffset.toISOString() : date.toISOString() };
    }
  }
  const modelSelection = original && original.modelSelection.instanceId === form.modelProvider && original.modelSelection.model === form.modelId
    ? original.modelSelection : { instanceId: form.modelProvider, model: form.modelId };
  return { ...(original ? { id: original.id, requireExisting: true, threadId: original.threadId,
    ...(original.threadMode ? { threadMode: original.threadMode } : {}) } : {}),
    commandId, title, prompt, enabled: form.enabled, schedule, projectId: original?.projectId ?? form.projectId,
    workspaceStrategy: original?.workspaceStrategy ?? { type: "root" }, modelSelection,
    runtimeMode: form.runtimeMode, interactionMode: form.interactionMode };
}
