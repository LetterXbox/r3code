// Subagent rows of the timeline, ported from the web app's TimelineV2EventRow.tsx (V2SubagentGroup),
// V2LifecycleRow.tsx (SubagentTimelineLink), client-runtime state/subagentDisplay.ts and
// shared/orchestrationTiming.ts (deriveSubagentElapsedMs). A `subagent` turn item carries the child's
// title, status, progress, result and timing; the thread's `subagents` projection (and the
// `subagent.updated` events) holds the live record of the same child by `subagentId`, and wins over
// the item, as the web's `liveAgents` lookup does.

/** AgentElapsed.tsx formatElapsedSeconds: "12s", "3m 05s", "1h 02m". */
function formatElapsed(totalMs: number): string {
  const seconds = Math.max(0, Math.floor(totalMs / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null);
const ms = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The part of a `subagent` turn item the timeline draws (OrchestrationV2TurnItem, type "subagent"). */
export type SubagentFields = {
  subagentId: string;
  providerInstanceId: string;
  driver: string;
  origin: string;
  childThreadId: string | null;
  /** The linked environment a remote task runs in (`remoteChild.label`). */
  remoteLabel: string | null;
  /** remoteChild's environment and thread there: the row opens it when this app is connected to that machine. */
  remote?: { environmentId: string; threadId: string } | null;
  title: string;
  status: string;
  progress: string | null;
  result: string | null;
  startedAt: number | null;
  completedAt: number | null;
  /** Consecutive subagent items of one run and provider turn fold into one group. */
  runId: string | null;
  providerTurnId: string | null;
  /** The model the child reported (OrchestrationV2Subagent.model), only known from the live record. */
  model: string | null;
  /** The reasoning effort in the child's model selection (REASONING_EFFORT_OPTION_IDS), from the live record. */
  effort?: string | null;
  /** The child's model selection as its live record names it (instance, model, options), for the speed mark. */
  selection?: { instanceId: string; model: string; options: { id: string; value: string | boolean }[] } | null;
};

const REASONING_EFFORT_OPTION_IDS = ["reasoningEffort", "effort", "reasoning", "variant", "reasoning_effort", "thinking_level"];
/** SubagentTooltipContent: the effort value in a model selection's options, the first effort id that has one. */
export function subagentEffort(modelSelection: unknown): string | null {
  const options = rec(modelSelection)?.options;
  if (!Array.isArray(options)) return null;
  for (const id of REASONING_EFFORT_OPTION_IDS) {
    const value = options.map(rec).find((option) => option?.id === id)?.value;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** The model selection of a subagent record, in the shape the tooltip reads. */
export function subagentSelection(modelSelection: unknown): NonNullable<SubagentFields["selection"]> | null {
  const selection = rec(modelSelection);
  const instanceId = text(selection?.instanceId);
  const model = text(selection?.model);
  if (!selection || !instanceId || !model) return null;
  const options = (Array.isArray(selection.options) ? selection.options : []).flatMap((entry) => {
    const option = rec(entry);
    return typeof option?.id === "string" && (typeof option.value === "string" || typeof option.value === "boolean") ? [{ id: option.id, value: option.value }] : [];
  });
  return { instanceId, model, options };
}

/** The subagent fields of a turn item, or undefined for any other item type. */
export function subagentFromTurnItem(item: Rec): SubagentFields | undefined {
  if (item.type !== "subagent" || typeof item.subagentId !== "string") return undefined;
  return {
    subagentId: item.subagentId,
    providerInstanceId: text(item.providerInstanceId) ?? "",
    driver: text(item.driver) ?? "",
    origin: text(item.origin) ?? "provider_native",
    childThreadId: text(item.childThreadId),
    remoteLabel: text(rec(item.remoteChild)?.label),
    remote: text(rec(item.remoteChild)?.environmentId) && text(rec(item.remoteChild)?.threadId) ? { environmentId: text(rec(item.remoteChild)?.environmentId)!, threadId: text(rec(item.remoteChild)?.threadId)! } : null,
    title: text(item.title) ?? "Subagent",
    status: text(item.status) ?? "pending",
    progress: text(item.progress),
    result: text(item.result),
    startedAt: ms(item.startedAt),
    completedAt: ms(item.completedAt),
    runId: text(item.runId),
    providerTurnId: text(item.providerTurnId),
    model: null,
  };
}

/** A live OrchestrationV2Subagent record laid over the item's own fields (status, progress, result, timing, title). */
export function overlaySubagent(fields: SubagentFields, record: Rec | undefined): SubagentFields {
  if (!record) return fields;
  return {
    ...fields,
    status: text(record.status) ?? fields.status,
    progress: record.progress !== undefined ? text(record.progress) : fields.progress,
    result: record.result !== undefined && !record.resultOmitted ? text(record.result) : fields.result,
    startedAt: record.startedAt !== undefined ? ms(record.startedAt) : fields.startedAt,
    completedAt: record.completedAt !== undefined ? ms(record.completedAt) : fields.completedAt,
    title: text(record.title) ?? fields.title,
    childThreadId: text(record.childThreadId) ?? fields.childThreadId,
    model: text(record.model)?.trim() || fields.model,
    effort: subagentEffort(record.modelSelection) ?? fields.effort ?? null,
    selection: subagentSelection(record.modelSelection) ?? fields.selection ?? null,
  };
}

export const subagentActive = (status: string) => status === "pending" || status === "running" || status === "waiting";
const SETTLED = new Set(["completed", "failed", "cancelled", "interrupted"]);
export const subagentSettled = (status: string) => SETTLED.has(status);

/** V2LifecycleRow STATUS_VISUALS: the label under a row with nothing else to say, and the dot colour token. */
export function subagentStatusVisual(status: string): { label: string; dot: "info" | "success" | "destructive" | "muted" } {
  switch (status) {
    case "pending": return { label: "Queued", dot: "info" };
    case "running": return { label: "Running", dot: "info" };
    case "waiting": return { label: "Waiting", dot: "info" };
    case "idle": return { label: "Idle · resumable", dot: "muted" };
    case "completed": return { label: "Completed", dot: "success" };
    case "failed": return { label: "Failed", dot: "destructive" };
    default: return { label: "Stopped", dot: "muted" };
  }
}

/** summarizeSubagentStatuses: "2 working · 4 done", the non-zero buckets in a fixed order. */
export function summarizeSubagentStatuses(statuses: readonly string[]): string {
  const counts = { working: 0, done: 0, failed: 0, stopped: 0, idle: 0 };
  for (const status of statuses) {
    if (subagentActive(status)) counts.working += 1;
    else if (status === "completed") counts.done += 1;
    else if (status === "failed") counts.failed += 1;
    else if (status === "idle") counts.idle += 1;
    else counts.stopped += 1;
  }
  return (Object.keys(counts) as Array<keyof typeof counts>).filter((key) => counts[key] > 0).map((key) => `${counts[key]} ${key}`).join(" · ");
}

/** subagentGroupSummary: whether any member is working, whether any failed. */
export function subagentGroupSummary(members: readonly { status: string }[]) {
  return { active: members.some(({ status }) => subagentActive(status)), failed: members.some(({ status }) => status === "failed") };
}

export const subagentCountLabel = (count: number) => `${count} ${count === 1 ? "subagent" : "subagents"}`;

/** formatSubagentDisplayTitle: drops a "Subagent:" prefix and turns `/root/a/some_name` into "Some Name". */
export function formatSubagentDisplayTitle(title: string): string {
  const display = title.replace(/^Subagent:\s*/i, "");
  const path = /^\/root\/(?:[^/]+\/)*([^/]+)\/?$/u.exec(display);
  if (path === null) return display;
  const name = path[1].replace(/[_\s]+/gu, " ").trim();
  return name.replace(/(^|\s)\S/gu, (letter) => letter.toUpperCase()) || display;
}

const GENERIC_CHILD_END = /^Child task ended with status\b/i;

function plainDetail(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/^[ \t]*[-*][ \t]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The second line of a row: the result once settled, else the progress; null when there is nothing but the status. */
export function subagentRowDetail(agent: Pick<SubagentFields, "status" | "progress" | "result">): string | null {
  const result = agent.result?.trim();
  const progress = agent.progress?.trim();
  const raw = subagentSettled(agent.status) ? result || progress : progress || result;
  return raw && !GENERIC_CHILD_END.test(raw) ? plainDetail(raw) || null : null;
}

/** The status word at the right of a row: only while there is a detail line and the child is not simply done. */
export const subagentTrailingStatus = (agent: Pick<SubagentFields, "status" | "progress" | "result">): string | null =>
  subagentRowDetail(agent) !== null && agent.status !== "completed" ? subagentStatusVisual(agent.status).label : null;

/** deriveSubagentElapsedMs: running children count to now, settled ones to their end; null without a start. */
export function subagentElapsedMs(agent: Pick<SubagentFields, "status" | "startedAt" | "completedAt">, now: number): number | null {
  if (agent.startedAt === null) return null;
  const end = subagentActive(agent.status) ? now : agent.completedAt;
  return end === null ? null : Math.max(0, end - agent.startedAt);
}

/** AgentElapsed: "19s", "1m 12s", "1h 02m", empty without a start. */
export function formatSubagentElapsed(agent: Pick<SubagentFields, "status" | "startedAt" | "completedAt">, now: number): string {
  const elapsed = subagentElapsedMs(agent, now);
  return elapsed === null ? "" : formatElapsed(elapsed);
}

/** subagentGroupTiming: earliest start to latest end; the group runs while any member does. */
export function subagentGroupTiming(agents: readonly Pick<SubagentFields, "status" | "startedAt" | "completedAt">[]): Pick<SubagentFields, "status" | "startedAt" | "completedAt"> {
  let start: number | null = null;
  let end: number | null = null;
  let endUnknown = false;
  for (const agent of agents) {
    if (agent.startedAt !== null) start = start === null ? agent.startedAt : Math.min(start, agent.startedAt);
    if (agent.completedAt !== null) end = end === null ? agent.completedAt : Math.max(end, agent.completedAt);
    else endUnknown = true;
  }
  const live = agents.some(({ status }) => subagentActive(status));
  return { status: live ? "running" : "completed", startedAt: start, completedAt: live || endUnknown || end === null ? null : end };
}

/** The groups the timeline draws: consecutive subagent items of one run and provider turn. */
export function groupSubagentItems<T extends { subagent?: SubagentFields }>(items: readonly T[]): T[][] {
  const groups: T[][] = [];
  for (const item of items) {
    const group = groups.at(-1);
    const previous = group?.at(-1)?.subagent;
    const current = item.subagent;
    if (group && previous && current && previous.runId === current.runId && previous.providerTurnId === current.providerTurnId) group.push(item);
    else groups.push([item]);
  }
  return groups;
}

/** subagentDetailPreview: the result once settled, else the progress, collapsed to one line of at most 280 characters. */
export function subagentDetailPreview(agent: Pick<SubagentFields, "status" | "progress" | "result">): string | null {
  const settled = subagentSettled(agent.status);
  const detail = ((settled ? agent.result : agent.progress)?.trimStart() || (settled ? agent.progress : agent.result)?.trimStart() || "");
  const compact = detail.trimEnd().replace(/\s+/gu, " ");
  if (compact === "") return null;
  return compact.length <= 280 ? compact : `${compact.slice(0, 280).trimEnd()}\u2026`;
}

/** V2LifecycleRow.logic subagentResumedSince: Claude can reuse resumed agent ids. Active agents supersede outcomes; settled agents must start after the notification. */
export function subagentResumedSince(agent: Pick<SubagentFields, "status" | "startedAt">, notifiedAt: number): boolean {
  if (subagentActive(agent.status)) return true;
  if (agent.startedAt === null) return false;
  return Number.isFinite(notifiedAt) && agent.startedAt > notifiedAt;
}

const NOTIFICATION_OUTCOME_STATUS: Record<string, string | null> = { completed: "completed", failed: "failed", cancelled: "cancelled", updated: null, unknown: null };
const NOTIFICATION_OUTCOME_LABEL: Record<string, string> = { completed: "Finished", failed: "Failed", cancelled: "Stopped", updated: "Updated", unknown: "Finished" };

export interface SubagentLinkEvent { status: string | null; label: string; timestamp: string }

/** SubagentNotificationLink: the event a notification shows on its child's row, or undefined once the child resumed since. */
export function subagentNotificationEvent(agent: Pick<SubagentFields, "status" | "startedAt">, outcome: string, notifiedAt: number, timestamp: string): SubagentLinkEvent | undefined {
  const status = NOTIFICATION_OUTCOME_STATUS[outcome] ?? null;
  if (status !== null && subagentResumedSince(agent, notifiedAt)) return undefined;
  return { status, label: NOTIFICATION_OUTCOME_LABEL[outcome] ?? "Finished", timestamp };
}

/** The live subagent a notification reports: a delegated task names its task ids, a subagent its child thread. */
export function notifiedSubagent(records: readonly Rec[], childThreadId: string, taskIds: readonly unknown[] | undefined): Rec | undefined {
  return records.find((agent) => taskIds === undefined ? agent.childThreadId === childThreadId : taskIds.includes(agent.id));
}

/** A live OrchestrationV2Subagent record as row fields. */
export function subagentFromRecord(record: Rec): SubagentFields | undefined {
  if (typeof record.id !== "string") return undefined;
  const base = subagentFromTurnItem({ ...record, type: "subagent", subagentId: record.id });
  return base ? overlaySubagent(base, record) : undefined;
}
