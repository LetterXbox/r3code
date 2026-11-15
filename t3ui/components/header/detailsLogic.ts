// The rules behind the thread details card's sections (chat/ThreadDetailsPrRows.tsx,
// ThreadServersPanel.tsx, ThreadAutomationsPanel.tsx, ThreadRelationshipsControl.tsx and
// BranchToolbar.logic.ts). Pure, so they are tested without an engine.
import type { ScheduledTask } from "../scheduled/data";
import { scheduleLabel } from "../scheduled/data";
import type { LinkedPullRequest, ThreadLineage } from "./threadRelations";

// --- environment and worktree ---------------------------------------------------------------

/** resolveLockedWorkspaceLabel: a started thread's workspace cannot change, so the row only names it. */
export function lockedWorkspaceLabel(worktreePath: string | null | undefined): string {
  return worktreePath ? "Worktree" : "Local checkout";
}

/** The row's icon: a worktree, a checkout inside one, or the project folder (FolderGit2 / FolderGit / Folder). */
export function workspaceIconName(worktreePath: string | null | undefined): "folder-git-2" | "folder" {
  return worktreePath ? "folder-git-2" : "folder";
}

/** The workspace mark: a worktree, a local checkout inside one (FolderGit), or the project folder. */
export function workspaceMarkName(worktreePath: string | null | undefined): "folder-git" | "folder" {
  return worktreePath ? "folder-git" : "folder";
}

/** The machine the thread's server runs on (`ServerConfig.environment`), for the Environment row. */
export interface EnvironmentDescriptor { label: string; machine: string }

const GENERIC_LOCAL_LABELS = ["local", "local environment"];
const MACHINE_KINDS = ["server", "cloud", "linux", "desktop", "laptop", "mac-mini", "mac-studio"];

/** The `server.getConfig` environment: the runtime label (a generic one reads "This device") and machine kind. */
export function readEnvironmentDescriptor(config: unknown): EnvironmentDescriptor | null {
  const root = record(config);
  const environment = record(root?.environment);
  const label = typeof environment?.label === "string" ? environment.label.trim() : "";
  if (!environment || label === "") return null;
  // resolveEnvironmentMachineKind: the settings override, then the platform's kind, then "server".
  const override = record(root?.settings)?.environmentIcon;
  const platform = record(environment.platform)?.machine;
  const machine = [override, platform].find((kind) => typeof kind === "string" && MACHINE_KINDS.includes(kind));
  return { label: GENERIC_LOCAL_LABELS.includes(label.toLowerCase()) ? "This device" : label, machine: typeof machine === "string" ? machine : "server" };
}

/** EnvironmentMachineIcon's kinds, as the header icon names (Linux has its own filled mark). */
export const MACHINE_ICON: Record<string, string> = {
  server: "server", cloud: "cloud", linux: "linux", desktop: "monitor", laptop: "laptop", "mac-mini": "mac-mini", "mac-studio": "mac-studio",
};

export function runContextLabel(label: string, environment?: string | null): string {
  return `Run context: ${[environment, label].filter(Boolean).join(", ")}`;
}

// --- pull requests ---------------------------------------------------------------------------

/** ThreadDetailsPrLinkRow: `#12: Title`, or just the number while no snapshot has synced. */
export function pullRequestRowLabel(link: Pick<LinkedPullRequest, "number" | "snapshot">): string {
  return `#${link.number}${link.snapshot === null ? "" : `: ${link.snapshot.title}`}`;
}

export type PullRequestTone = "open" | "draft" | "merged" | "closed";

export function pullRequestTone(link: Pick<LinkedPullRequest, "snapshot">): PullRequestTone {
  const state = link.snapshot?.state;
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  return link.snapshot?.isDraft === true ? "draft" : "open";
}

/** The rows under the current pull request: the other live links, shown behind "Show N more". */
export function otherPullRequests(links: readonly LinkedPullRequest[], current: LinkedPullRequest | null): LinkedPullRequest[] {
  if (current === null) return [];
  return links.filter((link) => !(link.host === current.host && link.repository === current.repository && link.number === current.number));
}

export function showMoreLabel(expanded: boolean, hidden: number): string {
  return expanded ? "Show less" : `Show ${hidden} more`;
}

// --- servers ---------------------------------------------------------------------------------

export const SERVER_PAGE_COUNT = 4;

export interface DiscoveredServer {
  host: string;
  port: number;
  url: string;
  processName: string | null;
  pid: number | null;
  terminal: { threadId: string; terminalId: string } | null;
  agentThreadId: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** One `subscribeDiscoveredLocalServers` value (DiscoveredLocalServerList). */
export function readDiscoveredServers(value: unknown): DiscoveredServer[] {
  const list = record(value);
  if (!list || !Array.isArray(list.servers)) return [];
  const servers: DiscoveredServer[] = [];
  for (const item of list.servers) {
    const server = record(item);
    if (!server || typeof server.port !== "number" || typeof server.url !== "string") continue;
    const terminal = record(server.terminal);
    const agent = record(server.agent);
    servers.push({
      host: typeof server.host === "string" ? server.host : "localhost",
      port: server.port,
      url: server.url,
      processName: typeof server.processName === "string" ? server.processName : null,
      pid: typeof server.pid === "number" ? server.pid : null,
      terminal: terminal && typeof terminal.threadId === "string" && typeof terminal.terminalId === "string" ? { threadId: terminal.threadId, terminalId: terminal.terminalId } : null,
      agentThreadId: agent && typeof agent.threadId === "string" ? agent.threadId : null,
    });
  }
  return servers;
}

/** useThreadDiscoveredPorts: the servers this thread's terminals or agent started. */
export function threadServers(servers: readonly DiscoveredServer[], threadId: string | null): DiscoveredServer[] {
  if (!threadId) return [];
  return servers.filter((server) => server.terminal?.threadId === threadId || server.agentThreadId === threadId);
}

export const serverKey = (server: Pick<DiscoveredServer, "pid" | "port">) => `${server.pid}:${server.port}`;
export const serverTitle = (server: Pick<DiscoveredServer, "port">) => `localhost:${server.port}`;
export function serverCaption(server: Pick<DiscoveredServer, "terminal" | "processName">): string {
  return [server.terminal === null ? "Agent" : "Terminal", server.processName].filter(Boolean).join(" · ");
}

// --- automations -----------------------------------------------------------------------------

/** The relative time ThreadAutomationsPanel's ScheduledRelativeLabel shows ("in 5m", "in 2h", "in 3d"). */
export function relativeUpcoming(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const seconds = Math.round((at - now) / 1000);
  if (seconds <= 45) return seconds < -45 ? "overdue" : "in under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/** taskScheduleLine: the schedule, then why it is blocked, when it runs next, or that it is paused. */
export function taskScheduleLine(task: ScheduledTask, now: number): string {
  const label = scheduleLabel(task.schedule);
  if (task.blockedByPolicy !== null) return `${label} · ${task.blockedByPolicy}`;
  if (task.enabled && task.nextRunAt !== null) return `${label} · next ${relativeUpcoming(task.nextRunAt, now)}`;
  return task.enabled ? label : `${label} · paused`;
}

export const AUTOMATION_DOT: Record<string, string> = {
  never: "bg-muted-foreground",
  running: "bg-info",
  succeeded: "bg-success",
  failed: "bg-destructive",
};

export const boundTasks = (tasks: readonly ScheduledTask[], threadId: string | null) => (threadId ? tasks.filter((task) => task.threadId === threadId) : []);

// --- lineage and side chats ------------------------------------------------------------------

export interface RelatedThread {
  id: string;
  title: string;
  lineage?: ThreadLineage | undefined;
  parentThreadId?: string | null;
}

export type RelationshipKind = "parent" | "fork" | "subagent" | "side-chat";

export interface RelationshipRow { threadId: string; title: string; kind: RelationshipKind; label: string }

const RELATION_LABELS: Record<RelationshipKind, string> = { parent: "Parent thread", fork: "Fork", subagent: "Subagent", "side-chat": "Side chat" };

/**
 * The immediate relationships of `current`: its parent (a fork's parent, or a subagent's parent agent),
 * then its forks and subagents, and its side chats. Lineage rows and Side chats rows come from one list,
 * as the web groups the same relationship rows.
 */
export function relationshipRows(current: { id: string; lineage?: ThreadLineage | undefined }, threads: readonly RelatedThread[]): { related: RelationshipRow[]; sideChats: RelationshipRow[] } {
  const related: RelationshipRow[] = [];
  const sideChats: RelationshipRow[] = [];
  const parentId = current.lineage?.parentThreadId ?? null;
  if (parentId && current.lineage?.sideChat !== true) {
    const parent = threads.find((thread) => thread.id === parentId);
    related.push({
      threadId: parentId,
      title: parent?.title ?? parentId,
      kind: "parent",
      label: current.lineage?.relationshipToParent === "subagent" ? "Parent agent" : RELATION_LABELS.parent,
    });
  }
  for (const thread of threads) {
    const lineage = thread.lineage;
    if (!lineage || lineage.parentThreadId !== current.id) continue;
    if (lineage.sideChat) sideChats.push({ threadId: thread.id, title: thread.title, kind: "side-chat", label: RELATION_LABELS["side-chat"] });
    else if (lineage.relationshipToParent === "subagent") related.push({ threadId: thread.id, title: thread.title, kind: "subagent", label: RELATION_LABELS.subagent });
    else if (lineage.relationshipToParent === "fork") related.push({ threadId: thread.id, title: thread.title, kind: "fork", label: RELATION_LABELS.fork });
  }
  return { related, sideChats };
}

export const LINEAGE_INITIAL_COUNT = 6;
export const LINEAGE_PAGE_COUNT = 12;

/** resolveThreadLineageWindow: how many rows show and how many "Show N more" hides. */
export function lineageWindow<Row>(rows: readonly Row[], visibleCount: number): { visibleRows: Row[]; hiddenCount: number } {
  const visibleRows = rows.slice(0, visibleCount);
  return { visibleRows, hiddenCount: rows.length - visibleRows.length };
}

// --- usage and context -----------------------------------------------------------------------

/** UsageRow's tone: at 90% context used the bar is an error, at 80% a warning. */
export function contextTone(usedPercent: number | null): "error" | "warning" | null {
  if (usedPercent === null) return null;
  return usedPercent >= 90 ? "error" : usedPercent >= 80 ? "warning" : null;
}

/** A limit window's tone: at 10% left an error, at 20% a warning. */
export function limitTone(percentLeft: number): "error" | "warning" | null {
  return percentLeft <= 10 ? "error" : percentLeft <= 20 ? "warning" : null;
}
