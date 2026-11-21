// scheduledTasksSettings.logic.ts and client-runtime scheduled-task-webhook.ts: the draft the Scheduled task dialog edits, how a task
// becomes a draft, how a draft becomes the `scheduledTasks.upsert` input, and the checks that stop a draft from saving.
import type { ScheduledTask, WebhookFilter } from "./data";

export type ScheduleMode = "fixed" | "once" | "interval" | "webhook";
export type WorkspaceMode = "root" | "worktree" | "existing_worktree";
export type ThreadMode = "new_thread" | "continue" | "fresh_session";

export const MIN_SCHEDULED_TASK_INTERVAL_MS = 60_000;
export const MAX_WEBHOOK_DELIVERY_AGE_MINUTES = 24 * 60;
export const MAX_WEBHOOK_FILTERS = 16;
export const DEFAULT_WEBHOOK_PROMPT = "Handle this webhook:\n{{body}}";
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
export const WORKSPACE_MODE_LABELS: Record<WorkspaceMode, string> = { worktree: "Create a new worktree", root: "Use the project checkout", existing_worktree: "Use a specific checkout" };
export const THREAD_MODE_LABELS: Record<ThreadMode, string> = { new_thread: "New thread each run", continue: "One thread, continuing the conversation", fresh_session: "One thread, fresh session each run" };
export const WEBHOOK_FILTER_OPS = [
  { op: "equals", label: "equals" }, { op: "notEquals", label: "does not equal" }, { op: "in", label: "is one of" }, { op: "startsWith", label: "starts with" }, { op: "exists", label: "exists" },
] as const;
export const WEBHOOK_SIGNATURE_DEFAULTS = { signatureHeader: "x-hub-signature-256", signatureEncoding: "hex" as "hex" | "base64", signaturePrefix: "sha256=" };

export interface FilterDraft { id: string; path: string; op: (typeof WEBHOOK_FILTER_OPS)[number]["op"]; value: string }

export interface DraftState {
  editingId: string | null;
  title: string;
  prompt: string;
  enabled: boolean;
  scheduleMode: ScheduleMode;
  intervalMinutes: string;
  timeOfDay: string;
  /** Local date and time, `YYYY-MM-DDTHH:MM`. */
  runAt: string;
  /** The stored ISO run time, sent back unchanged when the field was not edited. */
  savedRunAt: string;
  weekdays: number[];
  projectId: string;
  threadId: string;
  /** The thread the form opened with, so a save can distinguish clearing from never bound. */
  savedThreadId: string;
  threadMode: ThreadMode;
  workspaceMode: WorkspaceMode;
  baseRef: string;
  startFromOrigin: boolean;
  existingWorktreePath: string;
  modelProvider: string;
  modelId: string;
  runtimeMode: string;
  interactionMode: string;
  /** The task's own model selection, kept (with its options) while the picker leaves the model unchanged. */
  baseModelSelection: Record<string, unknown> | null;
  signatureEnabled: boolean;
  signatureHeader: string;
  signatureEncoding: "hex" | "base64";
  signaturePrefix: string;
  /** Write-only: empty keeps the secret already stored on the server. */
  signatureSecret: string;
  maxDeliveryAgeMinutes: string;
  replayKey: string;
  coalesceKey: string;
  coalesceWindowSeconds: string;
  filters: FilterDraft[];
  savedFilters: FilterDraft[];
}

export const EMPTY_DRAFT: DraftState = {
  editingId: null, title: "", prompt: "", enabled: true, scheduleMode: "fixed", intervalMinutes: "15", timeOfDay: "09:00", runAt: "", savedRunAt: "", weekdays: [1, 2, 3, 4, 5],
  projectId: "", threadId: "", savedThreadId: "", threadMode: "new_thread", workspaceMode: "worktree", baseRef: "", startFromOrigin: true, existingWorktreePath: "", modelProvider: "", modelId: "",
  runtimeMode: "full-access", interactionMode: "default", baseModelSelection: null, signatureEnabled: false, ...WEBHOOK_SIGNATURE_DEFAULTS, signatureSecret: "", maxDeliveryAgeMinutes: "",
  replayKey: "", coalesceKey: "", coalesceWindowSeconds: "", filters: [], savedFilters: [],
};

let lastFilterId = 0;
export const emptyFilterDraft = (): FilterDraft => ({ id: `filter-${++lastFilterId}`, path: "", op: "equals", value: "" });
export const removeFilterDraft = (drafts: readonly FilterDraft[], id: string) => drafts.filter((draft) => draft.id !== id);

export function filterDrafts(filters: readonly WebhookFilter[] | undefined): FilterDraft[] {
  return (filters ?? []).map((filter) => ({ id: `filter-${++lastFilterId}`, path: filter.path, op: filter.op, value: filter.op === "exists" ? "" : filter.op === "in" ? filter.value.join(", ") : filter.value }));
}

/** parseWebhookFilterDrafts: each row checked against the contract (a path under body, headers or query; a value unless it only checks existence). */
export function parseFilterDrafts(drafts: readonly FilterDraft[]): { filters: WebhookFilter[] } | { error: string } {
  if (drafts.length > MAX_WEBHOOK_FILTERS) return { error: `Use at most ${MAX_WEBHOOK_FILTERS} filters.` };
  const filters: WebhookFilter[] = [];
  for (const [index, draft] of drafts.entries()) {
    const path = draft.path.trim();
    const pathOk = /^(body|headers|query)(\.|$)/.test(path);
    const list = draft.value.split(",").map((item) => item.trim()).filter((item) => item !== "");
    const valid = pathOk && (draft.op === "exists" || (draft.op === "in" ? list.length > 0 && list.every((item) => /^[^,\s](?:[^,]*[^,\s])?$/.test(item)) : true));
    if (!valid) return { error: `Filter ${index + 1} needs a path under body, headers or query${draft.op === "exists" ? "." : draft.op === "in" ? ", and at least one value." : ", and a value."}` };
    filters.push(draft.op === "exists" ? { path, op: "exists" } : draft.op === "in" ? { path, op: "in", value: list } : { path, op: draft.op, value: draft.value });
  }
  return { filters };
}

export function filterDraftsChanged(saved: readonly FilterDraft[], current: readonly FilterDraft[]): boolean {
  return saved.length !== current.length || saved.some((filter, index) => filter.path !== current[index]?.path || filter.op !== current[index]?.op || (filter.op !== "exists" && filter.value !== current[index]?.value));
}

/** parseMaxDeliveryAge: blank is no limit; undefined is not a valid limit. */
export function parseMaxDeliveryAge(value: string): number | null | undefined {
  if (value.trim() === "") return null;
  const minutes = Number(value.trim());
  return Number.isInteger(minutes) && minutes > 0 && minutes <= MAX_WEBHOOK_DELIVERY_AGE_MINUTES ? minutes : undefined;
}

/** isWebhookDedupeTemplate: a template of request placeholders only. */
export function isDedupeTemplate(template: string): boolean {
  const placeholders = /\{\{\s*(?:(?:body|headers|query)(?:\.[^{}.\s]+)*|request)\s*\}\}/g;
  const matches = [...template.matchAll(placeholders)];
  const remainder = template.replace(placeholders, "");
  return matches.length > 0 && !remainder.includes("{{") && !remainder.includes("}}");
}

const pad = (value: number) => String(value).padStart(2, "0");
export const toDateTimeLocalValue = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

export interface DraftIssue { title: string; description: string }

/** scheduleDraftErrors: what keeps the schedule part of a draft from saving. */
export function scheduleDraftErrors(draft: DraftState): DraftIssue[] {
  if (draft.scheduleMode === "once") {
    const runAt = new Date(draft.runAt);
    if (Number.isNaN(runAt.getTime())) return [{ title: "Invalid run time", description: "Pick a date and time." }];
    if (toDateTimeLocalValue(runAt) !== draft.runAt) return [{ title: "Invalid run time", description: "That time does not exist in your time zone." }];
    return [];
  }
  if (draft.scheduleMode !== "webhook") return [];
  if (parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes) === undefined) return [{ title: "Invalid age limit", description: `Enter whole minutes from 1 to ${MAX_WEBHOOK_DELIVERY_AGE_MINUTES}, or leave it blank.` }];
  const errors: DraftIssue[] = [];
  for (const [label, value] of [["Duplicate request key", draft.replayKey], ["Coalesce key", draft.coalesceKey]] as const) {
    if (value.trim() && !isDedupeTemplate(value.trim())) errors.push({ title: "Invalid webhook settings", description: `${label} must contain a valid request placeholder.` });
  }
  const window = draft.coalesceWindowSeconds.trim();
  if (window && (!Number.isInteger(Number(window)) || Number(window) < 10 || Number(window) > 3600)) errors.push({ title: "Invalid webhook settings", description: "Coalesce window must be whole seconds from 10 to 3600." });
  return errors;
}

/** scheduleFromDraft: the upsert schedule, or null while the draft has errors. */
export function scheduleFromDraft(draft: DraftState): Record<string, unknown> | null {
  if (scheduleDraftErrors(draft).length > 0) return null;
  if (draft.scheduleMode === "once") {
    const saved = draft.savedRunAt ? new Date(draft.savedRunAt) : null;
    if (saved !== null && toDateTimeLocalValue(saved) === draft.runAt) return { type: "once", runAt: draft.savedRunAt };
    // A `datetime-local` value has no offset. In an hour that repeats when clocks go back, keep the saved time's offset.
    const withSavedOffset = saved === null ? null : new Date(Date.parse(`${draft.runAt}Z`) + saved.getTimezoneOffset() * 60_000);
    return { type: "once", runAt: withSavedOffset !== null && toDateTimeLocalValue(withSavedOffset) === draft.runAt ? withSavedOffset.toISOString() : new Date(draft.runAt).toISOString() };
  }
  if (draft.scheduleMode === "webhook") {
    const maxDeliveryAgeMinutes = parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes);
    const parsed = parseFilterDrafts(draft.filters);
    if (maxDeliveryAgeMinutes === undefined || !("filters" in parsed)) return null;
    const replayKey = draft.replayKey.trim();
    const coalesceKey = draft.coalesceKey.trim();
    const coalesceWindowSeconds = draft.coalesceWindowSeconds.trim() ? Number(draft.coalesceWindowSeconds) : undefined;
    const secret = draft.signatureSecret.trim();
    return {
      type: "webhook",
      signature: draft.signatureEnabled ? { header: draft.signatureHeader.trim(), encoding: draft.signatureEncoding, prefix: draft.signaturePrefix, ...(secret ? { secret } : {}) } : null,
      maxDeliveryAgeMinutes,
      dedupe: replayKey || coalesceKey || coalesceWindowSeconds !== undefined ? { ...(replayKey ? { replayKey } : {}), ...(coalesceKey ? { coalesceKey } : {}), ...(coalesceWindowSeconds === undefined ? {} : { coalesceWindowSeconds }) } : {},
      // Only edited filters are sent; the server keeps the stored ones otherwise.
      ...(filterDraftsChanged(draft.savedFilters, draft.filters) ? { filters: parsed.filters } : {}),
    };
  }
  if (draft.scheduleMode === "interval") return { type: "interval", everyMs: Math.round(Number(draft.intervalMinutes) * 60_000) };
  const everyDay = draft.weekdays.length === 0 || draft.weekdays.length === 7;
  return { type: "fixed_time", timeOfDay: draft.timeOfDay || "09:00", ...(everyDay ? {} : { weekdays: [...draft.weekdays].sort((a, b) => a - b) }) };
}

export function taskToDraft(task: ScheduledTask): DraftState {
  const schedule = task.schedule;
  const filters = filterDrafts(schedule.type === "webhook" ? schedule.filters : undefined);
  const strategy = task.workspaceStrategy as Record<string, unknown>;
  const mode = strategy.type === "root" || strategy.type === "existing_worktree" ? (strategy.type as WorkspaceMode) : "worktree";
  const signature = schedule.type === "webhook" ? schedule.signature : null;
  return {
    editingId: task.id, title: task.title, prompt: task.prompt, enabled: task.enabled,
    scheduleMode: schedule.type === "fixed_time" ? "fixed" : schedule.type === "unknown" ? "fixed" : schedule.type,
    intervalMinutes: schedule.type === "interval" ? String(Math.max(1, schedule.everyMs / 60_000)) : "15",
    // A time input shows nothing for an unpadded hour such as 9:05, which agents may save.
    timeOfDay: schedule.type === "fixed_time" ? schedule.timeOfDay.padStart(5, "0") : "09:00",
    runAt: schedule.type === "once" ? toDateTimeLocalValue(new Date(schedule.runAt)) : "",
    savedRunAt: schedule.type === "once" ? schedule.runAt : "",
    weekdays: schedule.type === "fixed_time" && schedule.weekdays && schedule.weekdays.length > 0 ? [...schedule.weekdays] : [0, 1, 2, 3, 4, 5, 6],
    projectId: task.projectId, threadId: task.threadId ?? "", savedThreadId: task.threadId ?? "",
    threadMode: (task.threadMode === "continue" || task.threadMode === "fresh_session" || task.threadMode === "new_thread") ? task.threadMode : task.threadId ? "continue" : "new_thread",
    workspaceMode: mode,
    baseRef: mode === "worktree" && typeof strategy.baseRef === "string" ? strategy.baseRef : "",
    startFromOrigin: mode === "worktree" ? strategy.startFromOrigin === true : true,
    existingWorktreePath: mode === "existing_worktree" && typeof strategy.worktreePath === "string" ? strategy.worktreePath : "",
    modelProvider: typeof task.modelSelection.instanceId === "string" ? task.modelSelection.instanceId : "",
    modelId: typeof task.modelSelection.model === "string" ? task.modelSelection.model : "",
    runtimeMode: task.runtimeMode, interactionMode: task.interactionMode, baseModelSelection: task.modelSelection,
    ...(signature ? { signatureEnabled: true, signatureHeader: signature.header, signatureEncoding: signature.encoding, signaturePrefix: signature.prefix } : { signatureEnabled: false, ...WEBHOOK_SIGNATURE_DEFAULTS }),
    signatureSecret: "",
    replayKey: schedule.type === "webhook" ? (schedule.dedupe?.replayKey ?? "") : "",
    coalesceKey: schedule.type === "webhook" ? (schedule.dedupe?.coalesceKey ?? "") : "",
    coalesceWindowSeconds: schedule.type === "webhook" && schedule.dedupe?.coalesceWindowSeconds !== undefined ? String(schedule.dedupe.coalesceWindowSeconds) : "",
    maxDeliveryAgeMinutes: schedule.type === "webhook" && schedule.maxDeliveryAgeMinutes != null ? String(schedule.maxDeliveryAgeMinutes) : "",
    filters, savedFilters: filters,
  };
}

/** Leaves the thread but keeps the mode; a task that left a thread does not share the project checkout. */
export function unbindDraftFromThread(draft: DraftState): DraftState {
  if (!draft.threadId) return draft;
  return { ...draft, threadId: "", ...(draft.workspaceMode === "root" ? { workspaceMode: "worktree" as const, startFromOrigin: true } : {}) };
}

export function moveDraftToThread(draft: DraftState, thread: { id: string; projectId: string }): DraftState {
  return { ...draft, threadId: thread.id, projectId: thread.projectId, threadMode: draft.threadMode === "new_thread" ? "continue" : draft.threadMode };
}

export function changeDraftProject(draft: DraftState, projectId: string): DraftState {
  return projectId === draft.projectId ? draft : { ...unbindDraftFromThread(draft), projectId, baseRef: "" };
}

/** scheduledTaskWorktreeBaseRef: an empty base picks the project's default branch, else main or master. */
export function scheduledTaskWorktreeBaseRef(baseRef: string, refs: readonly { name: string; isDefault?: boolean }[]): string {
  const picked = baseRef.trim();
  if (picked) return picked;
  const defaultRef = refs.find((ref) => ref.isDefault);
  if (defaultRef) return defaultRef.name;
  for (const name of ["main", "master"]) {
    const match = refs.find((ref) => ref.name === name || ref.name === `origin/${name}`);
    if (match) return match.name;
  }
  return "main";
}

/** The destination's description under its controls. */
export function destinationDetail(mode: ThreadMode, hasThread: boolean): string {
  if (mode === "new_thread") return "Each run starts a new thread with the workspace and model below.";
  if (!hasThread) return mode === "continue" ? "The first run starts a thread with the workspace and model below. Later runs continue that conversation." : "The first run starts a thread with the workspace and model below. Later runs post there, each in a fresh session without earlier runs' context.";
  return mode === "continue" ? "Each run continues this conversation, in its workspace and with its current model." : "Each run starts a fresh session in this thread, without earlier runs' context.";
}

export interface UpsertContext {
  projectIds: readonly string[];
  offersOnce: boolean;
  offersThreadModes: boolean;
  /** The task is a webhook task with a stored secret, so an empty secret field keeps it. */
  hasStoredSecret: boolean;
  commandId: string;
  /** Resolved base branch when draft.baseRef is blank (#32841). */
  resolvedBaseRef?: string;
}

/** The upsert input of a draft, or the first issue that stops it. */
export function upsertFromDraft(draft: DraftState, ctx: UpsertContext): { input: Record<string, unknown> } | { issues: DraftIssue[] } {
  if (!draft.title.trim() || !draft.prompt.trim() || !ctx.projectIds.includes(draft.projectId) || !draft.modelProvider || !draft.modelId) {
    return { issues: [{ title: "Scheduled task is incomplete", description: "Add a title, prompt, project, and model." }] };
  }
  const parsed = parseFilterDrafts(draft.filters);
  if (draft.scheduleMode === "webhook" && "error" in parsed) return { issues: [{ title: "Invalid filter", description: parsed.error }] };
  const schedule = scheduleFromDraft(draft);
  if (schedule === null) return { issues: scheduleDraftErrors(draft) };
  const signature = schedule.signature as { header: string; secret?: string } | null | undefined;
  if (schedule.type === "webhook" && signature && (!signature.header || (!signature.secret && !ctx.hasStoredSecret))) return { issues: [{ title: "Signing secret is required", description: "Enter the signature header and secret." }] };
  if (schedule.type === "interval" && (!Number.isSafeInteger(schedule.everyMs) || (schedule.everyMs as number) < MIN_SCHEDULED_TASK_INTERVAL_MS)) return { issues: [{ title: "Invalid interval", description: "Enter an interval of at least one minute." }] };
  if (schedule.type === "once" && !ctx.offersOnce) return { issues: [{ title: "Once is not available here", description: "This environment runs an older R3 Code. Update it to schedule a one-time task, or pick another schedule." }] };
  if (draft.workspaceMode === "existing_worktree" && !draft.existingWorktreePath.trim()) return { issues: [{ title: "Checkout path is required", description: "Enter the path of the checkout to run in." }] };
  const base = draft.baseModelSelection;
  const modelSelection = base && base.instanceId === draft.modelProvider && base.model === draft.modelId ? base : { instanceId: draft.modelProvider, model: draft.modelId };
  const worktreeBase = draft.baseRef.trim() || ctx.resolvedBaseRef?.trim() || "main";
  const workspaceStrategy = draft.workspaceMode === "root" ? { type: "root" } : draft.workspaceMode === "existing_worktree" ? { type: "existing_worktree", worktreePath: draft.existingWorktreePath.trim() } : { type: "worktree", baseRef: worktreeBase, startFromOrigin: draft.startFromOrigin };
  return {
    input: {
      ...(draft.editingId ? { id: draft.editingId, requireExisting: true } : {}),
      commandId: ctx.commandId,
      title: draft.title.trim(), prompt: draft.prompt.trim(), enabled: draft.enabled, schedule, projectId: draft.projectId,
      threadId: draft.threadId ? draft.threadId : null,
      ...(draft.threadId === "" && draft.savedThreadId !== "" ? { unbindThread: true } : {}),
      ...(ctx.offersThreadModes ? { threadMode: draft.threadMode } : {}),
      workspaceStrategy, modelSelection, runtimeMode: draft.runtimeMode, interactionMode: draft.interactionMode, creationSource: "web",
    },
  };
}

/** webhookAddress (client-runtime): the URL a task listens on, whether it can be copied, and what to tell the user. */
export function webhookAddress(endpoint: { path: string; url: string | null }, httpBaseUrl: string | null): { address: string; copyable: boolean; note: string | null } {
  if (endpoint.url !== null) return { address: endpoint.url, copyable: true, note: null };
  if (httpBaseUrl === null) return { address: endpoint.path, copyable: false, note: "Link this environment to T3 Connect for a public URL." };
  const url = `${httpBaseUrl.replace(/\/+$/, "")}${endpoint.path.startsWith("/") ? "" : "/"}${endpoint.path}`;
  const loopback = /^https?:\/\/(localhost|127\.|\[::1\])/i.test(url);
  return { address: url, copyable: true, note: loopback ? "Only this computer can call this address. Link T3 Connect for a public URL." : "Works wherever this environment's address is reachable, for example over Tailscale or your own proxy. Link T3 Connect for a public URL." };
}
