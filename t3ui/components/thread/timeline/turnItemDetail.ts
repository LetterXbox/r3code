// The structured turn item a work-log row carries (packages/contracts orchestrationV2.ts OrchestrationV2TurnItem),
// and the pure detail helpers the item inspector uses (packages/client-runtime work-log/itemDetail.ts,
// packages/shared toolOutput.ts readToolOutputImage). Ingestion keeps the server's item by reference, so this
// costs nothing per item; only an opened row reads it.

type Rec = Record<string, unknown>;

/** Fields every turn item carries (OrchestrationV2TurnItemBaseFields), loosely typed as they come off the wire. */
interface TurnItemBase {
  id: string;
  threadId?: string;
  runId?: string | null;
  status?: string;
  title?: string | null;
  ordinal?: number;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string;
  [key: string]: unknown;
}
export type FileChangeDetail = { operation?: string; path: string; oldPath?: string; fileType?: string; mimeType?: string };
export type FileSearchResult = { fileName: string; line?: number; column?: number; preview?: string };
export type WebSearchResult = { title?: string; url?: string; snippet?: string };
export type TodoStep = { text: string; status?: string };
export type UserInputQuestion = { question: string; options?: Array<{ label: string }> };
export type CheckpointFile = { path: string; kind?: string; additions?: number; deletions?: number };

export type TurnItem =
  | (TurnItemBase & { type: "reasoning"; text?: string })
  | (TurnItemBase & { type: "command_execution"; input?: string; output?: string; outputOmitted?: boolean; exitCode?: number })
  | (TurnItemBase & { type: "file_change"; fileName?: string; additions?: number; deletions?: number; diffStr?: string; changes?: FileChangeDetail[] })
  | (TurnItemBase & { type: "file_search"; pattern?: string; results?: FileSearchResult[] })
  | (TurnItemBase & { type: "web_search"; patterns?: string[]; results?: WebSearchResult[] })
  | (TurnItemBase & { type: "dynamic_tool"; toolName?: string | null; viewedImagePath?: string; input?: unknown; output?: unknown; outputOmitted?: boolean })
  | (TurnItemBase & { type: "approval_request"; prompt?: string })
  | (TurnItemBase & { type: "user_input_request"; questions?: UserInputQuestion[] })
  | (TurnItemBase & { type: "notification"; detail?: string; summary?: string })
  | (TurnItemBase & { type: "system_notice"; message?: string })
  | (TurnItemBase & { type: "error"; failure?: { message?: string; class?: string; resetAt?: string | null } })
  | (TurnItemBase & { type: "todo_list"; steps?: TodoStep[] })
  | (TurnItemBase & { type: "checkpoint"; checkpointId?: string; files?: CheckpointFile[]; filesTotal?: { files?: number; additions?: number; deletions?: number } })
  | (TurnItemBase & { type: "link_request"; url?: string; reason?: string; environmentId?: string; label?: string; hint?: string; requestedAccess?: string; linkStatus?: string; linkedEnvironmentId?: string; linkedLabel?: string; linkedAccess?: string; failure?: string })
  | (TurnItemBase & { type: string });

const isRecord = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);
const MAX_TEXT_BLOCK_DEPTH = 4;
const MAX_TOOL_OUTPUT_IMAGES = 8;
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);

/** The wire item as a TurnItem, or null for anything that is not one. */
export function asTurnItem(value: unknown): TurnItem | null {
  return isRecord(value) && typeof value.id === "string" && typeof value.type === "string" ? (value as TurnItem) : null;
}

function isSummarizedValue(value: unknown): boolean {
  return isRecord(value) && value.truncated === true && typeof value.summary === "string";
}

/** readToolOutputImage: an MCP or Anthropic image block with a supported image type. */
function isToolOutputImage(block: unknown): boolean {
  if (!isRecord(block) || block.type !== "image") return false;
  const source = isRecord(block.source) ? block.source : undefined;
  if (source !== undefined && source.type !== "base64") return false;
  const mimeType = source === undefined ? block.mimeType : source.media_type;
  return typeof mimeType === "string" && IMAGE_MIME.has(mimeType.toLowerCase());
}

function outputBlocks(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.content)) return value.content;
  return [value];
}

function toolOutputImageBlocks(value: unknown): unknown[] {
  const blocks: unknown[] = [];
  for (const block of outputBlocks(value)) {
    if (!isToolOutputImage(block)) continue;
    blocks.push(block);
    if (blocks.length === MAX_TOOL_OUTPUT_IMAGES) break;
  }
  return blocks;
}

function textFromBlocks(value: unknown, depth: number, imageBlocks: readonly unknown[]): string | null {
  if (depth > MAX_TEXT_BLOCK_DEPTH) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map((block) => textFromBlocks(block, depth + 1, imageBlocks));
    return parts.every((part) => part !== null) ? parts.filter((part) => part !== "").join("\n") : null;
  }
  if (!isRecord(value)) return null;
  if (value.type === "text" && typeof value.text === "string") return value.text;
  if (value.type === "image") return imageBlocks.includes(value) ? "" : "[image]";
  if (value.type === "resource_link" && typeof value.uri === "string") return value.uri;
  if (value.type === "resource" && isRecord(value.resource)) {
    const resource = value.resource;
    if (typeof resource.text === "string") return resource.text;
    if (typeof resource.uri === "string") return resource.uri;
  }
  const keys = Object.keys(value).filter((key) => key !== "isError" && key !== "is_error");
  if (keys.length === 1 && keys[0] === "content") return textFromBlocks(value.content, depth + 1, imageBlocks);
  if (keys.length === 2 && keys.includes("content") && keys.includes("structuredContent")) {
    const text = textFromBlocks(value.content, depth + 1, imageBlocks);
    const images = Array.isArray(value.content) ? value.content.filter((block) => isRecord(block) && block.type === "image") : [];
    const structured = formatJsonValue(value.structuredContent);
    if (structured !== null && (images.length > 0 || !text?.trim())) {
      const markers = textFromBlocks(images, depth + 1, imageBlocks);
      return [structured, markers].filter(Boolean).join("\n");
    }
    return text?.trim() ? text : null;
  }
  return null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function isJsonToolText(text: string): boolean {
  if (parseJson(text) !== undefined) return true;
  const documents = text.trim().split(/\n\s*\n/);
  return documents.length > 1 && documents.every((document) => parseJson(document) !== undefined);
}

function prettyJsonText(text: string): string {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return text;
  const whole = parseJson(trimmed);
  if (whole !== undefined) return JSON.stringify(whole, null, 2);
  const lines = trimmed.split("\n").filter((line) => line.trim());
  const documents = lines.map((line) => parseJson(line.trim()));
  if (documents.some((document) => document === undefined)) return text;
  return documents.map((document) => JSON.stringify(document, null, 2)).join("\n\n");
}

function formatJsonValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && !value.trim()) return null;
  let json: string | undefined;
  try {
    json = JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
  if (json === undefined || json === "{}" || json === "[]") return null;
  return json;
}

function formatToolValue(value: unknown, hasImagePreview = false): string | null {
  if (value === undefined || value === null) return null;
  if (hasImagePreview && isRecord(value) && value.type === "image") return null;
  const text = textFromBlocks(value, 0, toolOutputImageBlocks(value));
  if (text !== null) return text.trim() ? prettyJsonText(text) : null;
  return formatJsonValue(value);
}

export type ToolCallLines = { command: string | null; args: Array<readonly [string, string]> | null; argsText: string | null };

export function toolCallLines(input: { command?: string; args?: unknown }): ToolCallLines {
  if (input.command !== undefined) {
    const command = input.command.trim();
    return { command: command || null, args: null, argsText: null };
  }
  const args = input.args;
  if (isRecord(args) && !isSummarizedValue(args)) {
    const entries = Object.entries(args).flatMap(([key, value]): Array<readonly [string, string]> => {
      if (value === undefined) return [];
      // An empty string or null can be the point of a call (a clear or reset), so show it.
      return [[key, typeof value === "string" && value !== "" ? value : (JSON.stringify(value) ?? String(value))]];
    });
    return { command: null, args: entries.length > 0 ? entries : null, argsText: null };
  }
  return { command: null, args: null, argsText: formatToolValue(args) };
}

const toolCallHasLines = (lines: ToolCallLines) => lines.command !== null || lines.args !== null || lines.argsText !== null;

const LIVE = new Set(["idle", "pending", "running", "waiting"]);

/** A running item keeps one key, so an open row fetches once while it streams and again when it finishes. */
export function turnItemDetailRevision(item: TurnItem): string {
  return LIVE.has(String(item.status)) ? "live" : String(item.updatedAt ?? "");
}

export function turnItemNeedsDetailFetch(item: TurnItem): boolean {
  if (item.type === "command_execution") return item.outputOmitted === true;
  if (item.type === "dynamic_tool") return item.outputOmitted === true || isSummarizedValue((item as Rec).input);
  return false;
}

function commandOutputText(output: string): string {
  if (!output.trimStart().startsWith('{"stdout"')) return output;
  const parsed = parseJson(output.trim());
  if (!isRecord(parsed) || typeof parsed.stdout !== "string" || typeof parsed.stderr !== "string" || typeof parsed.interrupted !== "boolean") return output;
  return [parsed.stdout, parsed.stderr].filter((part) => part.trim().length > 0).join("\n");
}

export function turnItemOutputText(item: TurnItem): string | null {
  const it = item as Rec;
  switch (item.type) {
    case "command_execution": {
      const output = typeof it.output === "string" ? it.output : "";
      return output.trim() ? commandOutputText(output) || null : null;
    }
    case "dynamic_tool":
      return it.outputOmitted === true ? null : formatToolValue(it.output, it.viewedImagePath !== undefined);
    default:
      return null;
  }
}

/** How many tool-output-image assets an item has (the asset index is the block order). */
export function turnItemOutputImageCount(item: TurnItem): number {
  const it = item as Rec;
  if (item.type !== "dynamic_tool" || it.outputOmitted === true) return 0;
  return toolOutputImageBlocks(it.output).length;
}

export function turnItemHasDetail(item: TurnItem): boolean {
  const it = item as Rec;
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  const len = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  switch (item.type) {
    case "reasoning": return str(it.text).trim().length > 0;
    case "command_execution":
      return toolCallLines({ command: str(it.input) }).command !== null || it.outputOmitted === true || Boolean(str(it.output).trim()) ||
        (typeof it.exitCode === "number" && it.exitCode !== 0);
    case "file_change": case "checkpoint": case "fork": case "handoff": return true;
    case "file_search": return len(it.results) > 0 || Boolean(str(it.pattern).trim());
    case "web_search": return len(it.results) > 0 || len(it.patterns) > 0;
    case "dynamic_tool": return it.outputOmitted === true || toolCallHasLines(toolCallLines({ args: it.input }));
    case "approval_request": return Boolean(str(it.prompt).trim());
    case "user_input_request": return len(it.questions) > 0;
    case "notification": return Boolean(str(it.detail).trim());
    case "system_notice": return str(it.message).trim().length > 0;
    case "error": return str(isRecord(it.failure) ? it.failure.message : "").trim().length > 0;
    case "proposed_plan": return str(it.markdown).trim().length > 0;
    case "todo_list": return len(it.steps) > 0;
    case "subagent": return typeof it.childThreadId === "string";
    default: return false;
  }
}

/** The todo glyph V2ItemInspector draws per step. */
export function todoStepLines(steps: readonly TodoStep[]): string {
  return steps.map((step) => `${step.status === "completed" ? "✓" : step.status === "running" ? "◉" : "○"} ${step.text}`).join("\n");
}

/** The question list V2ItemInspector draws for a user-input request. */
export function userInputQuestionLines(questions: readonly UserInputQuestion[]): string {
  return questions.map((question) => [question.question, ...(question.options ?? []).map((option) => `• ${option.label}`)].join("\n")).join("\n\n");
}

/** formatWorkspaceRelativePath (filePathDisplay.ts, POSIX paths): a path under the root reads `<root name>/<rest>`. */
export function workspaceRelativePath(path: string, root: string | null | undefined): string {
  if (!root) return path;
  const trimmed = root.replace(/\/+$/u, "");
  const label = trimmed.split("/").pop() || trimmed;
  if (path === trimmed) return label;
  if (path.startsWith(`${trimmed}/`)) return `${label}/${path.slice(trimmed.length + 1)}`;
  if (!path.startsWith("/")) return path.startsWith(`${label}/`) ? path : `${label}/${path.replace(/^(\.\/)+/u, "")}`;
  return path;
}

const DIFF_COUNT_FORMAT = new Intl.NumberFormat();
/** formatDiffCount (client-runtime diffCount.ts). */
export const formatDiffCount = (value: number) => DIFF_COUNT_FORMAT.format(value);

/** A change line of a file_change item: `operation old -> new (type, mime)`. */
export function fileChangeLine(change: FileChangeDetail, root: string | null | undefined): string {
  const kinds = [change.fileType, change.mimeType].filter(Boolean).join(", ");
  return `${change.operation ?? ""} ${change.oldPath ? `${change.oldPath} → ` : ""}${workspaceRelativePath(change.path, root)}${kinds ? ` (${kinds})` : ""}`;
}
