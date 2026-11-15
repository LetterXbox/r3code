// A turn item as the timeline's activity row (store.ts threadActivity). Every kind of OrchestrationV2TurnItem
// (packages/contracts orchestrationV2.ts) that is not a message or an approval carries its text into `detail`,
// so nothing the web transcript draws is dropped: reasoning text, command input and output, file changes,
// searches, subagent prompt / progress / result, plans, notices, compaction and handoff summaries, retries.
import { getQuestionAnswerPreview, getQuestionTextPreview, hasQuestionAnswer, questionAnswerHistory, readQuestionAnswer } from "./questionAnswer";
import { subagentFromTurnItem, type SubagentFields } from "./subagents";
import { toolIconFromWire, type ToolIconFields } from "./toolIcon";
import { secretRequestFromTurnItem, type SecretRequestFields } from "./secretRequest";
import { turnItemNeedsDetailFetch, type TurnItem } from "./turnItemDetail";

/** ToolActivitySource (packages/contracts providerRuntime.ts): the integration, browser or computer a tool call went through. */
export type ToolSourceFields = { key: string; name: string; kind: "browser" | "computer" | "integration" };
export type ActivityFields = {
  id: string; type: string; title: string; detail: string; status: string; order: number; ordinal?: number; requestId?: string;
  /** A `subagent` item's child: title, status, progress, result, timing, thread. */
  subagent?: SubagentFields;
  /** The server's tool surface metadata (`toolSource`, `toolSurface`) and the tool's own name. */
  toolSource?: ToolSourceFields;
  toolSurface?: "browser" | "computer";
  /** The tool call's own icon (`toolIcon`, else its source's). */
  toolIcon?: ToolIconFields;
  toolName?: string;
  toolInput?: unknown;
  /** A `secret_request` item: what the agent asked for, and how the request stands. */
  secret?: SecretRequestFields;
  /** A `notification` item: where it came from (OrchestrationV2NotificationSource.kind) and how it ended. */
  notice?: { source: string; outcome: string };
  startedAt?: number;
  completedAt?: number;
  /** An `error` item: danger for a plain failure, neutral for a usage limit or a provider retry in progress. */
  tone?: "danger" | "neutral";
  /** The environment withheld a command's or tool's output: `getTurnItem` (orchestration.getTurnItem) has it. */
  outputOmitted?: boolean;
  threadId?: string;
  /** The detail revision getTurnItem takes: "live" while the item is working, else its updatedAt (turnItemDetailRevision). */
  revision?: string;
  /** The server's turn item itself (by reference, not copied): the inspector and cards render from its structure. */
  item?: TurnItem;
};

/** session-logic.ts providerErrorPresentation: the label and detail of a provider error, a retry or a usage limit. */
export function providerErrorPresentation(item: Rec): { label: string; detail: string } {
  const failure = rec(item.failure);
  const message = typeof failure?.message === "string" ? failure.message : "";
  const usageLimit = failure?.class === "usage_limit";
  const retry = rec(item.retry);
  if (!retry || typeof retry.attempt !== "number") {
    const title = typeof item.title === "string" ? item.title.trim() : "";
    return { label: usageLimit ? "Usage limit reached" : title || "Provider error", detail: message };
  }
  const progress = typeof retry.maxAttempts === "number" ? `${retry.attempt}/${retry.maxAttempts}` : `${retry.attempt}`;
  const label = item.status === "running" ? `Retrying provider (${progress})`
    : item.status === "completed" ? `Provider recovered (${progress} retries)`
    : item.status === "failed" ? `${usageLimit ? "Usage limit reached" : "Provider error"} after ${progress} retries`
    : `Provider retry stopped (${progress})`;
  const delay = typeof retry.retryDelayMs === "number" && retry.retryDelayMs > 0 && item.status === "running"
    ? retry.retryDelayMs < 1000 ? ` Retrying in ${retry.retryDelayMs}ms.` : ` Retrying in ${(retry.retryDelayMs / 1000).toFixed(1).replace(/\.0$/u, "")}s.`
    : "";
  return { label, detail: `${message}${delay}` };
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null);

/** Items drawn by their own surface: messages by the transcript. Approvals stay in the work log (TimelinePendingApprovalRow at their position). */
export const SEPARATE_SURFACE_TYPES = new Set(["user_message", "assistant_message"]);

export function activityTitle(type: string): string {
  const titles: Record<string, string> = {
    command_execution: "Command", file_change: "File change", file_search: "File search", web_search: "Web search",
    dynamic_tool: "Tool", reasoning: "Reasoning", proposed_plan: "Plan", todo_list: "Tasks", user_input_request: "Input requested",
    subagent: "Subagent", system_notice: "Notice", error: "Error", checkpoint: "Checkpoint", compaction: "Compacted context",
    notification: "Notification", handoff: "Context handoff", fork: "Fork", thread_created: "Created thread",
    run_interrupt_request: "Interrupting run", run_interrupt_result: "Run interrupted", secret_request: "Secret requested", link_request: "Link requested",
  };
  return titles[type] ?? type.replace(/_/g, " ");
}

export function activityDetail(item: Rec): string {
  const parts: string[] = [];
  const add = (value: unknown) => { if (typeof value === "string" && value.trim()) parts.push(value); };
  switch (item.type) {
    case "command_execution": add(item.input); add(item.output); break;
    case "file_change":
      add(item.fileName); add(item.diffStr);
      if (!item.diffStr && Array.isArray(item.changes)) for (const change of item.changes) add(rec(change)?.path);
      break;
    case "file_search":
      add(item.pattern);
      if (Array.isArray(item.results)) add(item.results.map((result) => {
        const entry = rec(result);
        return typeof entry?.fileName === "string" ? `${entry.fileName}${typeof entry.line === "number" ? `:${entry.line}` : ""}` : "";
      }).filter(Boolean).join("\n"));
      break;
    case "web_search":
      if (Array.isArray(item.patterns)) for (const value of item.patterns) add(value);
      if (Array.isArray(item.results)) add(item.results.map((result) => {
        const entry = rec(result);
        return [entry?.title, entry?.url].filter((value) => typeof value === "string" && value).join(" - ");
      }).filter(Boolean).join("\n"));
      break;
    case "dynamic_tool":
      add(item.toolName);
      if (typeof item.input === "string") add(item.input); else if (item.input != null) add(JSON.stringify(item.input));
      if (typeof item.output === "string") add(item.output); else if (item.output != null) add(JSON.stringify(item.output));
      break;
    case "reasoning": add(item.text); break;
    case "proposed_plan": add(item.markdown); break;
    case "todo_list":
      add(item.explanation);
      if (Array.isArray(item.steps)) for (const step of item.steps) {
        const entry = rec(step);
        if (typeof entry?.text === "string") add(`${entry.status === "completed" ? "[x]" : "[ ]"} ${entry.text}`);
      }
      break;
    case "subagent": add(item.prompt); add(item.progress); add(item.result); break;
    case "error": add(providerErrorPresentation(item).detail); break;
    case "user_input_request": {
      // TimelineWorkEntryRow: an answered request expands to its question / answer history.
      const answer = readQuestionAnswer(item.questionAnswer);
      if (answer) add(questionAnswerHistory(answer));
      else if (Array.isArray(item.questions)) for (const question of item.questions) add(rec(question)?.question);
      break;
    }
    case "notification": add(item.summary); add(item.detail); break;
    case "thread_created": add(item.targetModel); break;
    case "secret_request": add(item.reason); break;
    case "link_request": add(item.reason); break;
    default: add(item.message); add(item.summary);
  }
  if (item.outputOmitted === true) parts.push("[Output omitted by the environment]");
  const detail = parts.join("\n\n");
  return detail.length > 12000 ? `${detail.slice(0, 12000)}\n\n[Output truncated]` : detail;
}

/** The turn-item status the work log shows: a command that exited non-zero failed even when the run went on. */
export function activityStatus(item: Rec): string {
  const status = typeof item.status === "string" ? item.status : "";
  if (item.type === "command_execution" && status === "completed" && (typeof item.exitCode === "number" ? item.exitCode !== 0 : item.outputIndicatesFailure === true)) return "failed";
  return status;
}

/** One turn item as an activity row, or null when another surface draws it. */
export function activityFromTurnItem(item: Rec, order: number): ActivityFields | null {
  if (typeof item.id !== "string" || typeof item.type !== "string" || SEPARATE_SURFACE_TYPES.has(item.type)) return null;
  const answered = item.type === "user_input_request" ? readQuestionAnswer(item.questionAnswer) : undefined;
  // session-logic.ts: an answered request reads "Answered questions"; the row leads with the question text and the answer.
  const answeredTitle = answered ? [getQuestionTextPreview(answered) || (typeof item.title === "string" && item.title ? item.title : "Answered questions"), hasQuestionAnswer(answered) ? getQuestionAnswerPreview(answered) : ""].filter(Boolean).join(" \u00b7 ") : null;
  const title = answeredTitle ? answeredTitle : item.type === "error" ? providerErrorPresentation(item).label : typeof item.title === "string" && item.title ? item.title : item.type === "notification" && typeof item.summary === "string" && item.summary ? item.summary : activityTitle(item.type);
  const subagent = subagentFromTurnItem(item);
  const source = rec(item.toolSource);
  const kind = source?.kind;
  const toolSource: ToolSourceFields | undefined = source && typeof source.key === "string" && typeof source.name === "string" && (kind === "browser" || kind === "computer" || kind === "integration")
    ? { key: source.key, name: source.name, kind } : undefined;
  const toolIcon = toolIconFromWire(item.toolIcon) ?? toolIconFromWire(source?.icon);
  const started = typeof item.startedAt === "string" ? Date.parse(item.startedAt) : NaN;
  const completed = typeof item.completedAt === "string" ? Date.parse(item.completedAt) : NaN;
  return {
    id: item.id, type: item.type, title, detail: activityDetail(item), status: activityStatus(item), order, item: item as TurnItem,
    ...(item.type === "error" ? { tone: rec(item.retry) !== null || rec(item.failure)?.class === "usage_limit" ? "neutral" as const : "danger" as const } : {}),
    ...(turnItemNeedsDetailFetch(item as TurnItem) && typeof item.threadId === "string"
      ? { ...(item.outputOmitted === true ? { outputOmitted: true } : {}), threadId: item.threadId, revision: ["idle", "pending", "running", "waiting"].includes(String(item.status)) ? "live" : String(item.updatedAt ?? "") } : {}),
    ...(subagent ? { subagent } : {}),
    ...(item.type === "notification" ? { notice: { source: typeof rec(item.source)?.kind === "string" ? String(rec(item.source)?.kind) : "system", outcome: typeof item.outcome === "string" ? item.outcome : "updated" } } : {}),
    ...(toolSource ? { toolSource } : {}),
    ...(toolIcon ? { toolIcon } : {}),
    ...(item.type === "secret_request" ? (() => { const secret = secretRequestFromTurnItem(item); return secret ? { secret } : {}; })() : {}),
    ...(item.toolSurface === "browser" || item.toolSurface === "computer" ? { toolSurface: item.toolSurface } : {}),
    ...(item.type === "dynamic_tool" && typeof item.toolName === "string" ? { toolName: item.toolName } : {}),
    ...(item.type === "dynamic_tool" && item.input !== null && typeof item.input === "object" ? { toolInput: item.input } : {}),
    ...(Number.isFinite(started) ? { startedAt: started } : {}),
    ...(Number.isFinite(completed) ? { completedAt: completed } : {}),
    ...(typeof item.ordinal === "number" ? { ordinal: item.ordinal } : {}),
    ...(typeof item.requestId === "string" ? { requestId: item.requestId } : {}),
  };
}
