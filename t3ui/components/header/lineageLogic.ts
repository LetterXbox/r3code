// The rules behind the thread details card's Lineage and Side chats sections
// (chat/ThreadRelationshipsControl.tsx, client-runtime state/threadRelationships.ts and
// state/subagentDisplay.ts). Pure, so they are tested without an engine.
import type { ThreadLineage } from "./threadRelations";

/** A thread as the lineage rows read it: its lineage, run status and timing. */
export interface LineageThread {
  id: string;
  title: string;
  lineage?: ThreadLineage | undefined;
  forkSourceThreadId?: string | undefined;
  /** The shell's overall status and the current activity status, when present. */
  status?: string | null;
  activityRunStatus?: string | null;
  providerInstanceId?: string | null;
  createdAt?: number | null;
  startedAt?: number | null;
  completedAt?: number | null;
  /** The thread's latest run exists, so its own status outranks the subagent record's. */
  hasRun?: boolean;
}

/** One `projection.subagents` record, the parts the rows read. */
export interface ProjectedSubagent {
  id: string;
  childThreadId: string | null;
  title: string | null;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
  providerInstanceId: string | null;
}

export type LineageKind = "parent" | "fork" | "subagent" | "side-chat" | "transfer";

export interface ContextTransfer { sourceThreadId: string; targetThreadId: string; status: string | null }

export function readContextTransfers(projection: unknown): ContextTransfer[] {
  const root = typeof projection === "object" && projection !== null ? projection as Record<string, unknown> : null;
  const transfers = Array.isArray(root?.contextTransfers) ? root.contextTransfers : [];
  return transfers.flatMap((value): ContextTransfer[] => {
    if (typeof value !== "object" || value === null) return [];
    const transfer = value as Record<string, unknown>;
    if (typeof transfer.sourceThreadId !== "string" || typeof transfer.targetThreadId !== "string") return [];
    return [{ sourceThreadId: transfer.sourceThreadId, targetThreadId: transfer.targetThreadId, status: typeof transfer.status === "string" ? transfer.status : null }];
  });
}

export interface LineageRow {
  threadId: string;
  title: string;
  kind: LineageKind;
  /** The relationship, for the row's tooltip: "Parent thread", "Fork", "Subagent", "Parent agent", "Side chat". */
  label: string;
  status: string | null;
  providerInstanceId: string | null;
  startedAt: number | null;
  completedAt: number | null;
  /** A subagent row shows its elapsed time where other rows show their status. */
  isAgent: boolean;
  /** The current thread's parent (a CornerLeftUp row), as opposed to a child. */
  isParent: boolean;
}

export interface LineageModel {
  related: LineageRow[];
  active: LineageRow[];
  previous: LineageRow[];
  sideChats: LineageRow[];
  runningCount: number;
  runningSideChats: number;
  showLineage: boolean;
  showSideChats: boolean;
  /** `showHeading`: a lone "Previous agents" row names itself. */
  showLineageHeading: boolean;
}

const FINISHED = ["completed", "failed", "error", "cancelled", "interrupted", "idle"];
export const isFinishedAgentStatus = (status: string | null | undefined) => FINISHED.includes(status ?? "");
const isWorkActive = (status: string | null | undefined) => status === "pending" || status === "running" || status === "waiting";
const relationshipStatus = (status: string | null) => status === "rolled_back" ? "interrupted" : status;

/** formatSubagentDisplayTitle: drops a "Subagent:" prefix and prettifies a /root/... path. */
export function formatSubagentDisplayTitle(title: string): string {
  const display = title.replace(/^Subagent:\s*/i, "");
  const path = /^\/root\/(?:[^/]+\/)*([^/]+)\/?$/u.exec(display);
  if (path === null) return display;
  const name = (path[1] ?? "").replace(/[_\s]+/gu, " ").trim();
  return name.replace(/(^|\s)\S/gu, (letter) => letter.toUpperCase()) || display;
}

/** threadRelationshipStatusLabel */
export function relationshipStatusLabel(status: string | null): string {
  switch (status) {
    case "preparing": case "starting": return "Starting";
    case "running": case "in_progress": return "Running";
    case "pending": case "queued": return "Queued";
    case "waiting": case "blocked": return "Waiting";
    case "completed": return "Done";
    case "failed": case "error": return "Failed";
    case "cancelled": case "interrupted": return "Stopped";
    case "rolled_back": return "Reverted";
    case "resolved_native": return "Resolved (native)";
    case "resolved_portable": return "Resolved (portable)";
    case "consumed": return "Consumed";
    case "superseded": return "Superseded";
    case "idle": return "Idle";
    default: return "Unknown";
  }
}

/** ThreadRelationshipIcon's status dot colour token. */
export function relationshipDotClass(status: string | null): string {
  if (status === "running" || status === "in_progress" || status === "pending" || status === "waiting") return "bg-info";
  if (status === "failed" || status === "error") return "bg-destructive";
  if (status === "completed") return "bg-success";
  return "bg-details-dot-idle";
}

/** AgentElapsed's compact format: "42s", "4m", "1.5h". */
export function formatCompactElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  if (minutes >= 600) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 6) / 10}h`;
}

/** deriveSubagentElapsedMs, then the compact format; null while there is nothing to show. */
export function agentElapsedLabel(row: Pick<LineageRow, "status" | "startedAt" | "completedAt">, now: number): string | null {
  if (row.startedAt === null) return null;
  const end = isWorkActive(row.status) ? now : row.completedAt;
  if (end === null) return null;
  return formatCompactElapsed(Math.max(0, end - row.startedAt) / 1000);
}

function relationLabel(kind: LineageKind, isParent: boolean, currentIsSubagent: boolean): string {
  if (kind === "side-chat") return "Side chat";
  if (kind === "subagent") return isParent ? "Parent agent" : "Subagent";
  return isParent ? (currentIsSubagent ? "Parent agent" : "Parent thread") : "Fork";
}

/**
 * The Lineage and Side chats sections: the parent, the forks, the subagents (running ones, then the
 * finished ones behind "Previous agents") and the side chats, from the shell threads and the open
 * thread's projection. A parent or fork that no thread list nor title lookup knows is a deleted
 * thread, so it has no row; subagent rows always stay.
 */
export function lineageModel(input: {
  current: { id: string; lineage?: ThreadLineage | undefined; forkSourceThreadId?: string | undefined };
  threads: readonly LineageThread[];
  subagents?: readonly ProjectedSubagent[];
  /** Workflow coordinators use their own status even when their child shell reports a different one. */
  workflowStatuses?: ReadonlyMap<string, string>;
  transfers?: readonly ContextTransfer[];
  /** Statuses of agents whose child thread lives on a linked environment. */
  remoteStatuses?: readonly string[];
  /** Titles `orchestration.getThreadTitles` resolved for ids no thread list holds. */
  resolvedTitles?: ReadonlyMap<string, string>;
  mergeTargetThreadId?: string | null;
  canDetach?: boolean;
  /** The thread was delegated from a linked environment: its row alone is a reason to show Lineage. */
  delegatedFrom?: boolean;
  showLineage: boolean;
  showSideChats: boolean;
}): LineageModel {
  // Live shells precede archived snapshots; the latter can temporarily hold an older copy.
  const byId = new Map<string, LineageThread>();
  for (const thread of input.threads) if (!byId.has(thread.id)) byId.set(thread.id, thread);
  const subagents = input.subagents ?? [];
  const subagentByChild = new Map(subagents.flatMap((agent) => (agent.childThreadId ? [[agent.childThreadId, agent] as const] : [])));
  const titleOf = (id: string): string | null => byId.get(id)?.title ?? input.resolvedTitles?.get(id) ?? null;

  const rows: { row: LineageRow; createdAt: number | null; parent: boolean }[] = [];
  const seen = new Set<string>();
  const push = (row: LineageRow, createdAt: number | null, parent: boolean) => { if (!seen.has(row.threadId)) { seen.add(row.threadId); rows.push({ row, createdAt, parent }); } };

  const parentId = input.current.forkSourceThreadId ?? input.current.lineage?.parentThreadId ?? null;
  if (parentId) {
    const parent = byId.get(parentId);
    const title = titleOf(parentId);
    const isSubagent = input.current.lineage?.relationshipToParent === "subagent";
    if (title !== null) {
      push({
        threadId: parentId, title: isSubagent ? formatSubagentDisplayTitle(title) : title, kind: isSubagent ? "subagent" : "parent",
        label: relationLabel(isSubagent ? "subagent" : "parent", true, false), status: parent?.activityRunStatus ?? parent?.status ?? null,
        providerInstanceId: null, startedAt: null, completedAt: null, isAgent: false, isParent: true,
      }, null, true);
    }
  }
  for (const thread of byId.values()) {
    const lineage = thread.lineage;
    if (!lineage || (thread.forkSourceThreadId ?? lineage.parentThreadId) !== input.current.id) continue;
    const kind: LineageKind = lineage.sideChat ? "side-chat" : lineage.relationshipToParent === "subagent" ? "subagent" : "fork";
    const agent = subagentByChild.get(thread.id);
    // The thread's own status outranks the subagent record once it has run (deriveThreadRelationshipGraph).
    const status = kind === "subagent" && agent
      ? thread.activityRunStatus ?? (thread.hasRun && !isWorkActive(agent.status) ? thread.status ?? agent.status : agent.status)
      : thread.activityRunStatus ?? thread.status ?? agent?.status ?? null;
    push({
      threadId: thread.id, title: kind === "subagent" ? formatSubagentDisplayTitle(thread.title) : thread.title, kind, label: relationLabel(kind, false, false), status: kind === "subagent" ? relationshipStatus(input.workflowStatuses?.get(thread.id) ?? status) : status,
      providerInstanceId: agent?.providerInstanceId ?? thread.providerInstanceId ?? null,
      startedAt: thread.startedAt ?? agent?.startedAt ?? null, completedAt: thread.completedAt ?? agent?.completedAt ?? null, isAgent: kind === "subagent", isParent: false,
    }, thread.createdAt != null && Number.isFinite(thread.createdAt) ? thread.createdAt : null, false);
  }
  // A subagent whose child thread is not in the lists (idle children are left out of the shell).
  for (const agent of subagents) {
    if (!agent.childThreadId || seen.has(agent.childThreadId)) continue;
    const child = byId.get(agent.childThreadId);
    const status = child?.activityRunStatus ?? (child?.hasRun && !isWorkActive(agent.status) ? child.status ?? agent.status : agent.status);
    push({
      threadId: agent.childThreadId, title: formatSubagentDisplayTitle(titleOf(agent.childThreadId) ?? agent.title ?? agent.childThreadId), kind: "subagent", label: "Subagent",
      status: relationshipStatus(input.workflowStatuses?.get(agent.childThreadId) ?? status), providerInstanceId: agent.providerInstanceId ?? child?.providerInstanceId ?? null, startedAt: child?.startedAt ?? agent.startedAt, completedAt: child?.completedAt ?? agent.completedAt, isAgent: true, isParent: false,
    }, child?.createdAt != null && Number.isFinite(child.createdAt) ? child.createdAt : null, false);
  }

  // Transfer edges come after lineage and subagent edges in the reference graph.
  for (const transfer of input.transfers ?? []) {
    if (transfer.sourceThreadId === transfer.targetThreadId) continue;
    const id = transfer.sourceThreadId === input.current.id ? transfer.targetThreadId
      : transfer.targetThreadId === input.current.id ? transfer.sourceThreadId : null;
    if (!id || seen.has(id)) continue;
    const title = titleOf(id);
    if (title === null) continue;
    const thread = byId.get(id);
    push({ threadId: id, title, kind: "transfer", label: "Context transfer", status: transfer.status,
      providerInstanceId: null, startedAt: null, completedAt: null, isAgent: false, isParent: false },
      thread?.createdAt != null && Number.isFinite(thread.createdAt) ? thread.createdAt : null, false);
  }

  // orderWebThreadLineageRows: the parent first, then newest created first, unknown creation last.
  rows.sort((a, b) => {
    if (a.parent !== b.parent) return a.parent ? -1 : 1;
    const aTarget = a.row.threadId === input.mergeTargetThreadId;
    const bTarget = b.row.threadId === input.mergeTargetThreadId;
    if (aTarget !== bTarget) return aTarget ? -1 : 1;
    if (a.createdAt !== b.createdAt) {
      if (a.createdAt === null) return 1;
      if (b.createdAt === null) return -1;
      return b.createdAt - a.createdAt;
    }
    return a.row.threadId < b.row.threadId ? -1 : a.row.threadId > b.row.threadId ? 1 : 0;
  });

  const related: LineageRow[] = [];
  const active: LineageRow[] = [];
  const previous: LineageRow[] = [];
  const sideChats: LineageRow[] = [];
  for (const { row, parent } of rows) {
    if (!parent && row.kind === "side-chat") sideChats.push(row);
    else if (row.kind !== "subagent" || parent) related.push(row);
    else (isFinishedAgentStatus(row.status) ? previous : active).push(row);
  }
  const runningCount = subagents.filter((agent) => agent.childThreadId === null && agent.status === "running").length + active.filter((row) => row.status === "running").length;
  const canDetach = input.canDetach === true;
  const delegated = input.delegatedFrom === true;
  const remote = input.remoteStatuses ?? [];
  const remoteActive = remote.some((status) => !isFinishedAgentStatus(status));
  const showLineage = input.showLineage && (delegated || related.length > 0 || active.length > 0 || previous.length > 0 || runningCount > 0 || remote.length > 0 || (canDetach && sideChats.length > 0));
  return {
    related, active, previous, sideChats, runningCount,
    runningSideChats: sideChats.filter((row) => row.status === "running").length,
    showLineage,
    showSideChats: input.showSideChats && sideChats.length > 0,
    showLineageHeading: runningCount > 0 || canDetach || delegated || related.length > 0 || active.length > 0 || remoteActive,
  };
}

/** The section title: `Lineage · 1 running`. */
export const lineageTitle = (runningCount: number) => (runningCount > 0 ? `Lineage · ${runningCount} running` : "Lineage");
export const sideChatsTitle = (running: number) => (running > 0 ? `Side chats · ${running} running` : "Side chats");

/** canDetachThreadProviderSession, read off the raw projection: an attached session is neither stopped nor errored. */
export function projectionCanDetach(projection: unknown): boolean {
  const record = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
  const root = record(projection);
  if (!root) return false;
  const sessions = (Array.isArray(root.providerSessions) ? root.providerSessions : []).flatMap((item) => { const session = record(item); return session ? [session] : []; });
  const runs = (Array.isArray(root.runs) ? root.runs : []).flatMap((item) => { const run = record(item); return run ? [run] : []; });
  const activeRun = [...runs].reverse().find((run) => ["preparing", "starting", "queued", "running", "waiting", "pending"].includes(String(run.status)));
  const thread = record(root.thread);
  const providerThreads = (Array.isArray(root.providerThreads) ? root.providerThreads : []).flatMap((item) => { const entry = record(item); return entry ? [entry] : []; });
  const providerThreadId = (activeRun && typeof activeRun.providerThreadId === "string" ? activeRun.providerThreadId : null) ?? (typeof thread?.activeProviderThreadId === "string" ? thread.activeProviderThreadId : null);
  const attached = (providerThreadId ? providerThreads.find((entry) => entry.id === providerThreadId) : undefined)
    ?? providerThreads.find((entry) => entry.appThreadId === thread?.id && typeof entry.providerSessionId === "string");
  const sessionId = typeof attached?.providerSessionId === "string" ? attached.providerSessionId : null;
  const session = sessionId !== null
    ? sessions.find((candidate) => candidate.id === sessionId)
    : [...sessions].reverse().find((candidate) => candidate.status !== "stopped" && candidate.status !== "error");
  return session !== undefined && session.status !== "stopped" && session.status !== "error";
}

/** `projection.subagents`, read defensively. */
export function readProjectedSubagents(projection: unknown): ProjectedSubagent[] {
  const root = typeof projection === "object" && projection !== null ? (projection as Record<string, unknown>) : null;
  const list = root && Array.isArray(root.subagents) ? root.subagents : [];
  const time = (value: unknown) => { const at = typeof value === "string" ? Date.parse(value) : Number.NaN; return Number.isFinite(at) ? at : null; };
  return list.flatMap((item): ProjectedSubagent[] => {
    if (typeof item !== "object" || item === null) return [];
    const agent = item as Record<string, unknown>;
    if (typeof agent.id !== "string" || typeof agent.status !== "string") return [];
    return [{
      id: agent.id, childThreadId: typeof agent.childThreadId === "string" ? agent.childThreadId : null, title: typeof agent.title === "string" ? agent.title : null,
      status: agent.status, startedAt: time(agent.startedAt), completedAt: time(agent.completedAt), providerInstanceId: typeof agent.providerInstanceId === "string" ? agent.providerInstanceId : null,
    }];
  });
}

/** ThreadRelationshipsControl: a failed merge back, stop subagent or stop workflow toasts its title alone, without the server's reason. */
export const relationshipFailureToast = (title: string) => ({ type: "error" as const, title });
