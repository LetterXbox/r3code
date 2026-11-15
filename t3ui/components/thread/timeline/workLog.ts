// Pure presentation logic for tool/work rows, ported from the web app's
// presentation.ts (summarizeToolGroup), TimelineWorkEntryRow.logic.ts and
// AgentElapsed.tsx. The native store keeps one flat ActivityItem per turn item,
// so command input/output and file diffs are recovered from `detail`.
import { mcpAppFromToolItem, type McpAppReference } from "./mcpApp";
import { htmlRenderFromWorkItem, readResult, type HtmlRenderReference } from "./htmlRenderReference";
import type { ActivityItem, Message } from "../../../store";
import type { TimelineEntry } from "../timeline";
import { deriveLiveRow, LIVE_ACTIVITY_ROW_ID, type LiveRow } from "./liveTurn";
import { toolLifecycleStatus } from "./liveTurn";
import { t3McpDefinition, t3McpToolId, t3McpToolLabel } from "./t3McpTools";
import { groupSubagentItems, subagentActive, type SubagentFields } from "./subagents";
import { formatTokens } from "../../usage/usageFormat";
import type { SecretRequestFields } from "./secretRequest";
import { compactionTitles, titledCompactionLabel } from "./idleCompaction";

export type WorkItem = Pick<ActivityItem, "id" | "type" | "title" | "detail" | "status"> & Partial<Pick<ActivityItem, "subagent" | "toolSource" | "toolIcon" | "secret" | "toolSurface" | "toolName" | "toolInput" | "notice" | "startedAt" | "completedAt" | "tone" | "outputOmitted" | "threadId" | "revision" | "item">> & { order?: number };

const FAILED = new Set(["failed", "declined", "error", "errored"]);
const ACTIVE = new Set(["inProgress", "in_progress", "running", "pending", "waiting", "started"]);

export const itemFailed = (item: WorkItem) => FAILED.has(item.status) || item.type === "error";
/** T3 keeps ordinary failed tool labels muted; only a severe error item colors the whole row. */
export const itemUsesDestructiveLabel = (item: WorkItem) => item.type === "error";
export const itemActive = (item: WorkItem) => ACTIVE.has(item.status);

/** activityDetail() joins command input and output with a blank line: the first block is the command. */
export function splitCommandDetail(detail: string): { command: string; output: string } {
  const cut = detail.indexOf("\n\n");
  if (cut < 0) return { command: detail.trim(), output: "" };
  return { command: detail.slice(0, cut).trim(), output: detail.slice(cut + 2).trim() };
}

/** A file_change detail is the file name, a blank line, then the diff. */
export function splitFileChange(detail: string): { fileName: string; diff: string } {
  const cut = detail.indexOf("\n\n");
  if (cut < 0) return { fileName: detail.trim(), diff: "" };
  return { fileName: detail.slice(0, cut).trim(), diff: detail.slice(cut + 2) };
}

export function diffStat(diff: string): { added: number; removed: number } | null {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return added === 0 && removed === 0 ? null : { added, removed };
}

/** workEntryIconName for one entry: the tool's surface (browser, computer) and a T3 MCP tool's mark first, then its kind. */
export function workItemIconName(item: WorkItem): string {
  if (item.type === "todo_list") return "list-todo";
  if (item.toolSurface === "browser" || item.toolSurface === "computer") return "browser-app";
  const definition = item.type === "dynamic_tool" ? t3McpDefinition(item.toolName, item.toolInput) : null;
  // workEntryIconName: a JavaScript REPL tool (isJavaScriptReplTool) shows the code mark.
  if (item.type === "dynamic_tool" && (item.toolName === "js" || item.toolName === "cua_repl.js" || item.toolName === "node_repl.js")) return "code";
  if (definition) return definition.icon === "browser" ? "browser-app" : definition.icon === "device" ? "smartphone" : definition.icon === "pull-request" ? "git-pull-request-arrow" : "t3-code";
  return workIconName(item.type);
}

/** workEntryIconName: command, edit, code search, web search, thought, subagent, list, prompt and failure marks. */
export function workIconName(type: string): string {
  switch (type) {
    case "command_execution": return "terminal";
    case "file_change": return "square-pen";
    case "file_search": return "search";
    case "web_search": return "globe";
    case "reasoning": return "brain";
    case "subagent": return "bot";
    case "todo_list": return "list-todo";
    case "error": return "circle-alert";
    case "user_input_request":
    case "approval_request": return "message-circle";
    default: return "wrench";
  }
}

/** remarkThoughtPreview: a reasoning preview flattens Markdown (emphasis, code, headings, lists, quotes, links, images, HTML) into label text. Formulas stay as their source text. */
export function flattenThoughtPreview(markdown: string): string {
  return markdown
    .replace(/<[^>]+>/g, "")
    .replace(/^\s{0,3}\[[^\]]+\]:\s*\S+.*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/```[^\n]*\n?/g, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const firstLine = (value: string) => value.trim().split("\n")[0]?.trim() ?? "";

/** The one-line label of a work entry, in the web app's phrasing. */
export function workRowLabel(item: WorkItem): string {
  const active = itemActive(item);
  switch (item.type) {
    case "command_execution": {
      const command = firstLine(splitCommandDetail(item.detail).command);
      return command || (active ? "Running command" : "Ran command");
    }
    case "file_change": {
      const name = firstLine(splitFileChange(item.detail).fileName);
      return name ? `${active ? "Editing" : "Edited"} ${name}` : "File change";
    }
    case "file_search": return active ? "Searching code" : "Searched code";
    case "web_search": return active ? "Searching the web" : "Searched the web";
    case "reasoning": return flattenThoughtPreview(item.detail) || (active ? "Thinking" : "Thought");
    case "dynamic_tool": return t3McpToolLabel(item.toolName, item.toolInput, toolLifecycleStatus(item.status)) ?? (firstLine(item.detail) || item.title);
    default: return item.title;
  }
}

type Action = "command" | "edit" | "search" | "web" | "thought" | "thread-read" | "other";

function actionOf(item: WorkItem): Action {
  if (t3McpDefinition(item.toolName, item.toolInput)?.summaryAction === "thread-read") return "thread-read";
  switch (item.type) {
    case "command_execution": return "command";
    case "file_change": return "edit";
    case "file_search": return "search";
    case "web_search": return "web";
    case "reasoning": return "thought";
    default: return "other";
  }
}

const times = (count: number) => (count === 1 ? "time" : "times");

function actionLabel(action: Action, count: number): string {
  switch (action) {
    case "command": return `Ran ${count} ${count === 1 ? "command" : "commands"}`;
    case "edit": return `Changed ${count} ${count === 1 ? "file" : "files"}`;
    case "search": return `Searched code ${count} ${times(count)}`;
    case "web": return `Searched the web ${count} ${times(count)}`;
    case "thought": return count === 1 ? "Thought" : `Thought (×${count})`;
    case "thread-read": return `Read ${count} ${count === 1 ? "thread" : "threads"}`;
    case "other": return `Used ${count} ${count === 1 ? "tool" : "tools"}`;
  }
}

/** toolGroupSummaryIconName: one kind of action keeps its own mark; a mix takes the hammer. */
function groupIcon(order: Action[]): string {
  if (order.length !== 1) return "hammer";
  switch (order[0]) {
    case "command": return "terminal";
    case "edit": return "square-pen";
    case "search": return "search";
    case "web": return "globe";
    case "thought": return "brain";
    case "thread-read": return "hammer";
    case "other": return "hammer";
  }
}

/** The "Used <names>" lead of a group summary; "integration(s)" follows when every source is an integration. */
export function sourceSummary(sources: readonly NonNullable<WorkItem["toolSource"]>[]): string {
  const names = [...new Set(sources.map((source) => source.name))];
  const formatted = names.length < 2 ? names[0] ?? "" : names.length === 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
  const all = sources.every((source) => source.kind === "integration");
  return `Used ${formatted}${all ? ` ${names.length === 1 ? "integration" : "integrations"}` : ""}`;
}

/** summarizeToolGroup: the two leading actions, joined as a sentence, the rest as "other actions". */
export function summarizeWorkGroup(items: readonly WorkItem[]): { summary: string; hasFailure: boolean; icon: string } {
  const tools = items.filter((item) => item.type !== "reasoning");
  // The group header reflects the latest tool's outcome, as the reference
  // does; an earlier failed command does not colour a later successful group.
  const hasFailure = tools.length > 0 && itemFailed(tools[tools.length - 1]!);
  if (items.length > 0 && tools.length === 0) return { summary: actionLabel("thought", items.length), hasFailure, icon: "brain" };
  const order: Action[] = [];
  const counts = new Map<Action, number>();
  const sources = new Map<string, NonNullable<WorkItem["toolSource"]>>();
  const changedFiles = new Set<string>();
  let editsWithoutDetails = 0;
  for (const item of tools) {
    // A call through a named integration is summarised by the integration ("Used kimi-cu integration"), not counted.
    if (item.toolSource && t3McpToolId(item.toolName) === null) {
      sources.set(item.toolSource.key, item.toolSource);
      continue;
    }
    const action = actionOf(item);
    if (!counts.has(action)) order.push(action);
    if (action === "edit") {
      const raw = item.item;
      const paths = raw?.type === "file_change" && Array.isArray(raw.changes)
        ? raw.changes.map((change) => change.path).filter((path): path is string => typeof path === "string" && path.length > 0)
        : [];
      const fileName = raw?.type === "file_change" && typeof raw.fileName === "string" ? raw.fileName : firstLine(splitFileChange(item.detail).fileName);
      if (paths.length > 0) paths.forEach((path) => changedFiles.add(path));
      else if (fileName) changedFiles.add(fileName);
      else editsWithoutDetails += 1;
      counts.set(action, changedFiles.size + editsWithoutDetails);
    } else counts.set(action, (counts.get(action) ?? 0) + 1);
  }
  const ranked = [...order].sort((a, b) => (a === "other" ? 1 : 0) - (b === "other" ? 1 : 0));
  const selected = ranked.slice(0, 2).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const labels = selected.map((action) => actionLabel(action, counts.get(action) ?? 0));
  const sourced = tools.filter((item) => item.toolSource && t3McpToolId(item.toolName) === null).length;
  const remaining = tools.filter((item) => !(item.toolSource && t3McpToolId(item.toolName) === null) && !selected.includes(actionOf(item))).length;
  if (sources.size > 0) labels.unshift(sourceSummary([...sources.values()]));
  if (remaining > 0) labels.push(`Performed ${remaining} other ${remaining === 1 ? "action" : "actions"}`);
  const sentence = labels.map((label, index) => (index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1)));
  const summary = sentence.length < 3 ? sentence.join(" and ") : `${sentence.slice(0, -1).join(", ")}, and ${sentence.at(-1)}`;
  return { summary, hasFailure, icon: groupIcon(order) };
}

/** formatWorkingTimerNow: "12s", then formatDuration ("1m 5s", "1h 2m 3s"). */
export function formatWorkingTimer(totalMs: number): string {
  const seconds = Math.max(0, Math.round(totalMs / 1000));
  if (Math.floor(totalMs / 1000) < 60) return `${Math.max(0, Math.floor(totalMs / 1000))}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return [hours > 0 ? `${hours}h` : "", minutes > 0 ? `${minutes}m` : "", rest > 0 ? `${rest}s` : ""].filter(Boolean).join(" ");
}

/** AgentElapsed: "12s", "3m 05s", "1h 02m". */
export function formatElapsed(totalMs: number): string {
  const seconds = Math.max(0, Math.floor(totalMs / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export type TimelineRow =
  | { kind: "entry"; id: string; entry: TimelineEntry }
  | { kind: "work"; id: string; items: WorkItem[]; active: boolean }
  | { kind: "plan"; id: string; item: WorkItem }
  /** A `secret_request` item: a standalone card (pending) or line (answered). */
  | { kind: "secret"; id: string; item: WorkItem & { secret: SecretRequestFields } }
  | { kind: "subagents"; id: string; items: (WorkItem & { subagent: SubagentFields })[]; active: boolean }
  /** A `notification` turn item: a standalone row that starts a new response and is never folded or grouped (TimelineWorkEntryRow). */
  | { kind: "notice"; id: string; item: WorkItem }
  /** ChangedFilesCard: the files a run's checkpoint recorded, drawn where the checkpoint item lands (after the reply). */
  | { kind: "changed-files"; id: string; item: WorkItem }
  /** A completed html_render call: its published page, drawn inline (HtmlRenderTimelineRow). */
  | { kind: "html-render"; id: string; item: WorkItem; htmlRender: HtmlRenderReference }
  | { kind: "mcp-app"; id: string; item: WorkItem; mcpApp: McpAppReference }
  /** LinkRequestCard: an agent asked to link another environment. */
  | { kind: "link"; id: string; item: WorkItem }
  /** A failed `error` turn item (TimelineWorkEntryRow): label, failure message, Retry for workspace preparation. */
  | { kind: "failure"; id: string; item: WorkItem }
  | { kind: "divider"; id: string; label: string; detail: string; tone: "neutral" | "danger"; /** ContextCompactionTimelineRow: a compaction divider leads with the minimize icon. */ compaction?: boolean; /** The compaction is still running: its label is swept. */ active?: boolean; /** V2LifecycleRow: a mark before the label (the stop mark of an interrupted run, the fork mark). */ icon?: string; /** The detail wraps instead of truncating (an interrupted run's message). */ wrapDetail?: boolean; /** A fork divider opens the thread it names. */ action?: { label: string; threadId: string }; /** A created-thread divider's run (attachCreatedThreadSummaries). */ runId?: string; /** A created-thread summary repeated under its run's reply. */ resourceSummary?: boolean }
  | { kind: "working"; id: string; since: number | null; /** A context compaction is running: "Compacting for 4s". */ compacting?: boolean; /** The worktree is being set up: "Setting up worktree...". */ preparing?: boolean }
  | LiveRow
  | { kind: "thinking"; id: string };

const DIVIDER_TYPES = new Set(["system_notice", "compaction", "run_interrupt_result", "fork", "thread_created", "handoff"]);
/** Items the web timeline never draws as a row (session-logic.ts skips `checkpoint`; its diff rides on the reply). */
const compactionRunId = (item: WorkItem): string | undefined => (typeof item.item?.runId === "string" ? item.item.runId : undefined);
const HIDDEN_TYPES = new Set(["checkpoint", "run_interrupt_request"]);

/** V2LifecycleRow's divider copy for the lifecycle items that are not tool calls. */
const DIVIDER_LABELS: Record<string, string> = {
  run_interrupt_result: "Run interrupted",
  fork: "Forked from conversation",
  handoff: "Context handoff",
};

/**
 * Folds consecutive tool activity into one collapsible work group, and lifts
 * plans, errors and notices into their own rows. `running` appends the working
 * indicator, counted from the latest user message.
 */
export function buildTimelineRows(entries: readonly TimelineEntry[], running: boolean, workStartedAt?: number | null, options: { preparingWorktree?: boolean; /** The fork / run_interrupt_result turn item behind a divider, as the server sent it. */ lifecycle?: (itemId: string) => Record<string, unknown> | undefined } = {}): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let group: WorkItem[] | null = null;
  const closeGroup = () => {
    if (group && group.length > 0) rows.push({ kind: "work", id: `work:${group[0].id}`, items: group, active: group.some(itemActive) });
    group = null;
  };
  let lastUser: Message | undefined;
  // Idle / resume compaction titles ("Context compacted after 2h 5m idle", "Context compacted before sending").
  const idle = compactionTitles(entries as Parameters<typeof compactionTitles>[0]);
  for (const entry of entries) {
    if (entry.kind === "message") {
      closeGroup();
      if (entry.message.role === "user") lastUser = entry.message;
      rows.push({ kind: "entry", id: entry.id, entry });
      continue;
    }
    const item = entry.activity;
    if (item.type === "checkpoint" && Array.isArray(item.item?.files) && item.item.files.length > 0) {
      closeGroup();
      rows.push({ kind: "changed-files", id: entry.id, item });
      continue;
    }
    if (HIDDEN_TYPES.has(item.type)) continue;
    // An answered "compact before continuing?" question folds into the compaction it asked for.
    if (item.type === "user_input_request" && idle.foldsQuestion(item)) continue;
    // MessagesTimeline.logic: a tool call that produced an MCP app shows the app as its own row.
    const mcpApp = item.type === "dynamic_tool" && item.item ? mcpAppFromToolItem(item.item as Record<string, unknown>) : undefined;
    if (mcpApp) {
      closeGroup();
      rows.push({ kind: "mcp-app", id: entry.id, item, mcpApp });
      continue;
    }
    const htmlRender = item.type === "dynamic_tool" ? htmlRenderFromWorkItem(item) : undefined;
    if (htmlRender) {
      closeGroup();
      rows.push({ kind: "html-render", id: entry.id, item, htmlRender });
      continue;
    }
    if (item.type === "notification") {
      closeGroup();
      rows.push({ kind: "notice", id: entry.id, item });
    } else if (item.type === "proposed_plan") {
      closeGroup();
      rows.push({ kind: "plan", id: entry.id, item });
    } else if (item.type === "link_request" && item.item) {
      closeGroup();
      rows.push({ kind: "link", id: entry.id, item });
    } else if (item.type === "secret_request" && item.secret) {
      closeGroup();
      rows.push({ kind: "secret", id: entry.id, item: item as WorkItem & { secret: SecretRequestFields } });
    } else if (item.type === "error" && item.item?.status === "failed") {
      closeGroup();
      rows.push({ kind: "failure", id: entry.id, item });
    } else if (item.type === "error" || DIVIDER_TYPES.has(item.type)) {
      closeGroup();
      const label = DIVIDER_LABELS[item.type] ?? (item.type === "thread_created" ? "Created thread" : item.type === "compaction" && itemActive(item) ? (idle.activeLabel(compactionRunId(item)) ?? "Compacting context") : item.title);
      let detail = item.type === "thread_created" ? (item.title === "Created thread" ? "" : item.title) : firstLine(item.detail);
      const lifecycle = item.type === "run_interrupt_result" || item.type === "fork" || item.type === "compaction" ? options.lifecycle?.(item.id) : undefined;
      let extra: Partial<Extract<TimelineRow, { kind: "divider" }>> = {};
      let compactionLabel: string | undefined;
      let compactionFailed = false;
      if (item.type === "compaction" && lifecycle && !itemActive(item)) {
        // contextCompactionLabel: failed, stopped, then the token counts; a failure's summary follows the label.
        const status = lifecycle.status;
        const before = lifecycle.beforeTokenCount;
        const after = lifecycle.afterTokenCount;
        compactionFailed = status === "failed";
        compactionLabel = compactionFailed ? "Context compaction failed"
          : status === "cancelled" || status === "interrupted" ? "Context compaction stopped"
          : typeof before === "number" && typeof after === "number" ? `Context compacted ${formatTokens(before)} \u2192 ${formatTokens(after)} tokens` : "Context compacted";
        compactionLabel = titledCompactionLabel(compactionLabel, idle.title(entry.id, compactionRunId(item)));
        detail = compactionFailed && typeof lifecycle.summary === "string" ? lifecycle.summary.trim() : "";
      }
      if (item.type === "thread_created") {
        // TimelineWorkEntryRow: a created thread's row carries "Open chat" for its target thread.
        const target = (item.item as Record<string, unknown> | undefined)?.targetThreadId;
        if (typeof target === "string" && target) extra = { action: { label: "Open chat", threadId: target } };
        const createdRun = (item.item as Record<string, unknown> | undefined)?.runId;
        if (typeof createdRun === "string") extra = { ...extra, runId: createdRun };
      }
      if (item.type === "run_interrupt_result") {
        // V2LifecycleRow: the stop mark, and the server's message wrapped as the detail.
        if (typeof lifecycle?.message === "string") detail = lifecycle.message;
        extra = { icon: "circle-stop", wrapDetail: true };
      } else if (item.type === "fork" && lifecycle) {
        const source = lifecycle.source !== null && typeof lifecycle.source === "object" ? lifecycle.source as Record<string, unknown> : {};
        const fromRun = source.type === "run";
        const target = fromRun ? source.threadId : lifecycle.targetThreadId;
        detail = "";
        extra = { icon: "git-fork", ...(typeof target === "string" ? { action: { label: fromRun ? "Open source conversation" : "Open fork", threadId: target } } : {}) };
        rows.push({ kind: "divider", id: entry.id, label: fromRun ? "Forked from conversation" : "Conversation fork", detail, tone: "neutral", ...extra });
        continue;
      }
      rows.push({ kind: "divider", id: entry.id, label: compactionLabel ?? label, detail, tone: compactionFailed || (item.type === "error" && item.tone !== "neutral") ? "danger" : "neutral", ...extra, ...(item.type === "compaction" ? (compactionFailed ? { icon: "circle-alert" } : { compaction: true, active: itemActive(item) }) : {}) });
    } else if (item.subagent) {
      // A subagent card is not a tool call: it closes the tool group and gathers with its neighbours (V2SubagentGroup).
      closeGroup();
      const previous = rows[rows.length - 1];
      const member = item as WorkItem & { subagent: SubagentFields };
      const joined = previous && previous.kind === "subagents" ? groupSubagentItems([...previous.items, member]) : null;
      if (previous && previous.kind === "subagents" && joined && joined.length === 1) {
        previous.items = joined[0] as typeof previous.items;
        previous.active = previous.items.some((entry) => subagentActive(entry.subagent.status));
      } else rows.push({ kind: "subagents", id: `subagents:${item.id}`, items: [member], active: subagentActive(item.subagent.status) });
    } else {
      (group ??= []).push(item);
    }
  }
  closeGroup();
  if (running) {
    const since = workStartedAt ?? (lastUser?.order !== undefined && lastUser.order > 0 ? lastUser.order : null);
    let lastUserIndex = -1;
    rows.forEach((row, index) => { if (rowIsUser(row)) lastUserIndex = index; });
    // The trailing tool group of the live turn is the live row: its thought, then the running tool.
    let hasActivityRow = false;
    let failedTail = false;
    const tail = rows[rows.length - 1];
    if (tail && tail.kind === "work" && rows.length - 1 > lastUserIndex) {
      const live = deriveLiveRow(tail.id, tail.items, itemActive);
      failedTail = live.failed;
      if (live.row) {
        rows[rows.length - 1] = live.row;
        hasActivityRow = live.row.active;
      }
    }
    // appendWorkingRow: the indicator sits right under the prompt, ahead of the turn's activity.
    // A compaction shows only its live divider, never a "Compacting" working row as well (MessagesTimeline.logic.ts):
    // mid-turn the row keeps counting the turn; a `/compact` run has no working row, only the divider.
    let manualCompaction: boolean | undefined;
    for (let index = entries.length - 1; index >= 0 && manualCompaction === undefined; index -= 1) {
      const entry = entries[index];
      if (entry.kind === "activity" && entry.activity.type === "compaction") manualCompaction = false;
      else if (entry.kind === "message" && entry.message.role === "user") manualCompaction = /^\/compact(?:\s|$)/i.test(entry.message.body.trim());
    }
    const compactRun = lastUser !== undefined && /^\/compact(?:\s|$)/i.test(lastUser.body.trim());
    if (manualCompaction === true) rows.push({ kind: "divider", id: "compaction:pending", label: "Compacting context", detail: "", tone: "neutral", compaction: true, active: true });
    // hasActiveCompaction: no Thinking row while a compaction item is still running.
    const compacting = compactRun || entries.some((entry) => entry.kind === "activity" && entry.activity.type === "compaction" && itemActive(entry.activity));
    const preparing = options.preparingWorktree === true;
    const working: TimelineRow = { kind: "working", id: "working", since, ...(preparing ? { preparing: true } : {}) };
    if (compactRun && !preparing) return rows;
    if (lastUserIndex >= 0) rows.splice(lastUserIndex + 1, 0, working);
    else rows.unshift(working);
    if ((failedTail || !hasActivityRow) && !compacting && !preparing) rows.push({ kind: "thinking", id: LIVE_ACTIVITY_ROW_ID });
  }
  return rows;
}

function rowIsUser(row: TimelineRow) {
  return row.kind === "entry" && row.entry.kind === "message" && row.entry.message.role === "user";
}

/** TimelineSystemDivider / proposedPlanTitle helpers. */
export function proposedPlanTitle(markdown: string): string | null {
  const heading = markdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : null;
}

/** Plan body without its leading heading, as the card shows it under the title. */
export function proposedPlanBody(markdown: string): string {
  const lines = markdown.trimEnd().split(/\r?\n/);
  let start = lines[0] && /^\s{0,3}#{1,6}\s+/.test(lines[0]) ? 1 : 0;
  while (lines[start]?.trim().length === 0) start += 1;
  // stripDisplayedPlanMarkdown also drops a leading "Summary" heading.
  if (lines[start]?.match(/^\s{0,3}#{1,6}\s+(.+)$/)?.[1]?.trim().toLowerCase() === "summary") {
    start += 1;
    while (lines[start]?.trim().length === 0) start += 1;
  }
  return lines.slice(start).join("\n");
}

/** Narrows a row to one kind, for If/When children. */
export function asKind<K extends TimelineRow["kind"]>(row: TimelineRow, kind: K): Extract<TimelineRow, { kind: K }> | undefined {
  return row.kind === kind ? (row as Extract<TimelineRow, { kind: K }>) : undefined;
}

export function rowMessage(row: TimelineRow): Message | undefined {
  return row.kind === "entry" && row.entry.kind === "message" ? row.entry.message : undefined;
}

/**
 * MessagesTimeline.logic settleSupersededReasoning: a reasoning item still marked running that is not the last entry has been
 * superseded by what came after it; it shows as settled so an old "Thinking" spinner stops.
 */
export function settleSupersededReasoning(entries: readonly TimelineEntry[]): TimelineEntry[] {
  return entries.map((entry, index) => {
    if (index === entries.length - 1 || entry.kind !== "activity" || entry.activity.type !== "reasoning" || !itemActive(entry.activity)) return entry;
    return { ...entry, activity: { ...entry.activity, status: "completed" } };
  });
}

/**
 * MessagesTimeline.logic withoutSubagentDelegationRows: a delegate_task call whose child has its own subagent card in the same
 * run is not drawn twice (the card stands for it); failed calls and calls whose task has no card stay.
 */
export function withoutSubagentDelegationRows(entries: readonly TimelineEntry[]): TimelineEntry[] {
  const childrenByRun = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry.kind !== "activity") continue;
    const item = entry.activity.item as Record<string, unknown> | undefined;
    if (item?.type !== "subagent" || item.origin !== "app_owned" || typeof item.runId !== "string" || typeof item.subagentId !== "string") continue;
    const children = childrenByRun.get(item.runId) ?? new Set<string>();
    children.add(item.subagentId);
    childrenByRun.set(item.runId, children);
  }
  return entries.filter((entry) => {
    if (entry.kind !== "activity" || itemFailed(entry.activity)) return true;
    const item = entry.activity.item as Record<string, unknown> | undefined;
    if (!item || item.type !== "dynamic_tool" || typeof item.runId !== "string" || (item.status !== "running" && item.status !== "completed")) return true;
    if (t3McpDefinition(typeof item.toolName === "string" ? item.toolName : null)?.summaryAction !== "delegate") return true;
    const result = readResult(item.output);
    if (result.failed) return true;
    const taskId = result.data?.taskId;
    return typeof taskId === "string" ? !childrenByRun.get(item.runId)?.has(taskId) : true;
  });
}

/**
 * MessagesTimeline.logic: a stopped compaction's own divider already says it stopped, so the run's interrupt result is not
 * shown again (a `/compact` run that has its compaction item); interrupt requests never show.
 */
export function withoutStoppedCompactionInterrupts(entries: readonly TimelineEntry[]): TimelineEntry[] {
  const compactionRuns = new Set<string>();
  const compactedRuns = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "message" && entry.message.role === "user" && typeof entry.message.runId === "string"
      && entry.message.body.trim().toLowerCase() === "/compact" && (entry.message.attachments?.length ?? 0) === 0) compactionRuns.add(entry.message.runId);
    if (entry.kind === "activity" && entry.activity.type === "compaction") {
      const runId = (entry.activity.item as Record<string, unknown> | undefined)?.runId;
      if (typeof runId === "string") compactedRuns.add(runId);
    }
  }
  return entries.filter((entry) => {
    if (entry.kind !== "activity") return true;
    if (entry.activity.type === "run_interrupt_request") return false;
    if (entry.activity.type !== "run_interrupt_result") return true;
    const runId = (entry.activity.item as Record<string, unknown> | undefined)?.runId;
    return !(typeof runId === "string" && compactionRuns.has(runId) && compactedRuns.has(runId));
  });
}

/**
 * MessagesTimeline.logic attachCreatedThreadSummaries: the threads a run created are summarised again right under the run's
 * reply (the last assistant message of the run), and the original row is dropped when it sits after that reply.
 */
export function attachCreatedThreadSummaries<R extends { id: string; kind: string }>(rows: readonly R[]): R[] {
  const terminal = new Map<string, number>();
  rows.forEach((row, index) => {
    const message = row.kind === "entry" ? rowMessage(row as unknown as TimelineRow) : undefined;
    if (message?.role === "assistant" && message.runId) terminal.set(message.runId, index);
  });
  const created = new Map<string, R[]>();
  for (const row of rows) {
    const divider = row as unknown as Extract<TimelineRow, { kind: "divider" }>;
    if (row.kind === "divider" && divider.runId && divider.action?.label === "Open chat") created.set(divider.runId, [...(created.get(divider.runId) ?? []), row]);
  }
  if (created.size === 0) return [...rows];
  return rows.flatMap((row, index): R[] => {
    const divider = row as unknown as Extract<TimelineRow, { kind: "divider" }>;
    if (row.kind === "divider" && divider.runId && divider.action?.label === "Open chat") {
      const at = terminal.get(divider.runId);
      if (at !== undefined && index > at) return [];
    }
    const message = row.kind === "entry" ? rowMessage(row as unknown as TimelineRow) : undefined;
    if (message?.role === "assistant" && message.runId && terminal.get(message.runId) === index) {
      return [row, ...(created.get(message.runId) ?? []).map((entry) => ({ ...entry, id: `summary:${entry.id}`, resourceSummary: true }))];
    }
    return [row];
  });
}
