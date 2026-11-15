// The live turn's rows, ported from the web app's MessagesTimeline.logic.ts (liveWorkEntryLabel,
// work-live / thinking rows), client-runtime work-log/presentation.ts (liveThoughtLine,
// liveActivityToolStatus) and a compact commandLabel.ts commandProgramName.
import type { WorkItem } from "./workLog";
import { t3McpToolLabel } from "./t3McpTools";

export type LiveStatus = "inProgress" | "completed" | "failed" | "declined" | "stopped" | "idle";

/** projectedWorkEntryStatus: the turn-item status as the work log reads it. */
export function toolLifecycleStatus(status: string): LiveStatus {
  switch (status) {
    case "pending":
    case "running":
    case "waiting":
    case "inProgress":
    case "in_progress":
    case "started":
      return "inProgress";
    case "idle": return "idle";
    case "failed":
    case "error":
    case "errored": return "failed";
    case "declined": return "declined";
    case "cancelled":
    case "interrupted":
    case "stopped": return "stopped";
    default: return "completed";
  }
}

/** liveActivityToolStatus: a live row is in the present tense while the turn is still using tools. */
export function liveActivityToolStatus(status: LiveStatus, presentTense: boolean): LiveStatus {
  if (status === "failed" || status === "declined" || status === "stopped" || status === "idle") return status;
  return presentTense || status === "inProgress" ? "inProgress" : "completed";
}

/** liveThoughtLine: the heading of a reasoning summary, else its first sentence, stripped of markdown. */
export function liveThoughtLine(markdown: string): string {
  const heading = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)/.exec(markdown)?.[1];
  const text = (heading ?? markdown)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/`+|\*\*|~~/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (heading !== undefined) return text;
  const end = /[.?!]["'”’)]?(?=\s)/.exec(text);
  return end ? text.slice(0, end.index + end[0].length) : text;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "fish"]);
const WRAPPERS = new Set(["builtin", "command", "exec", "nocorrect", "noglob", "time", "sudo", "env", "nohup"]);
const NON_DESCRIPTIVE = new Set((
  "! # . : [ [[ alias and autoload begin bg bind bindkey break builtin caller case catch cd command compgen complete compopt continue coproc " +
  "declare dirs disown do done elif else enable end esac eval exec exit export false fc fg fi finally for foreach function getopts history if in " +
  "jobs let local logout mapfile nocorrect noglob not or popd pushd read readarray readonly repeat return select set setopt shift shopt source " +
  "switch suspend test then time times trap try true type typeset ulimit umask unalias until unset unsetopt wait while"
).split(" "));
const PREFIX = "<>(){}[];|&$`#!%@:";
const SUFFIX = "){]}`";

function tokenize(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < command.length) current += command[++index];
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && index + 1 < command.length) {
      current += command[++index];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) tokens.push(current);
  return tokens;
}

/** The first command segment: up to an unquoted `&&`, `||`, `;`, `|` or newline, and the rest. */
function firstSegment(command: string): { head: string; rest: string | null } {
  let quote: string | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"') index += 1;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "\\") index += 1;
    else if (char === ";" || char === "\n" || char === "|" || char === "&") {
      const width = (char === "|" || char === "&") && command[index + 1] === char ? 2 : 1;
      if (char === "&" && width === 1) continue;
      return { head: command.slice(0, index), rest: command.slice(index + width) };
    }
  }
  return { head: command, rest: null };
}

/** commandProgramName: the program a command runs, looking through shell wrappers, `cd x &&`, env assignments and sudo. */
export function commandProgramName(command: string, depth = 0): string | null {
  if (depth > 4) return null;
  let rest: string | null = command.trim();
  let segments = 6;
  while (rest !== null && segments-- > 0) {
    const { head, rest: after } = firstSegment(rest);
    rest = after === null ? null : after.trim();
    const tokens = tokenize(head.trim());
    if (!tokens || tokens.length === 0) continue;
    let index = 0;
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
    let program = tokens[index]?.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, "") ?? "";
    if (SHELLS.has(program)) {
      // `bash -lc "script"`: the script is the program's real command.
      const flag = tokens.findIndex((token, at) => at > index && /^-[A-Za-z]*c[A-Za-z]*$/.test(token));
      const script = flag >= 0 ? tokens[flag + 1] : undefined;
      if (script !== undefined && flag + 2 >= tokens.length) {
        const inner = commandProgramName(script, depth + 1);
        if (inner) return inner;
      }
      return null;
    }
    while (WRAPPERS.has(program)) {
      index += 1;
      while (tokens[index]?.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index += 1;
      program = tokens[index]?.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, "") ?? "";
    }
    if (!program || NON_DESCRIPTIVE.has(program) || PREFIX.includes(program[0]) || SUFFIX.includes(program.at(-1) ?? "") || program.endsWith("()")) continue;
    return program;
  }
  return null;
}

const collapse = (value: string) => value.trim().replace(/\s+/g, " ");

/** workEntryDisplayLabel for the entries a live row can show. */
function displayLabel(item: WorkItem, command: string, status: LiveStatus): string {
  if (item.type === "command_execution") return command || item.title;
  if (item.type === "file_change") return item.detail.split("\n")[0]?.trim() || item.title;
  if (item.type === "dynamic_tool") return t3McpToolLabel(item.toolName, item.toolInput, status) ?? item.title;
  return item.title;
}

/** liveWorkEntryLabel: "Running cat" while the tool runs, then "Ran cat" / "Failed cat" / "Declined cat" / "Stopped cat". */
export function liveWorkLabel(item: WorkItem, presentTense: boolean, command = ""): string {
  const status = liveActivityToolStatus(toolLifecycleStatus(item.status), presentTense);
  if (item.type === "reasoning") return collapse(item.detail) || (status === "inProgress" ? "Thinking" : "Thought");
  if (item.type === "command_execution" && command.trim()) {
    const verb = status === "inProgress" ? "Running" : status === "failed" ? "Failed" : status === "declined" ? "Declined" : status === "stopped" ? "Stopped" : "Ran";
    return `${verb} ${commandProgramName(command) ?? "command"}`;
  }
  return displayLabel(item, command, status);
}

/** workEntryIsVisibleInGroup for a live group: a reasoning item shows once it has text. */
export const liveEntryVisible = (item: WorkItem) => (item.type === "reasoning" ? item.detail.trim().length > 0 : true);

export type LiveRow = {
  kind: "live";
  id: string;
  groupId: string;
  items: WorkItem[];
  /** The running tool, else the latest entry. */
  entry: WorkItem;
  /** The latest reasoning text, shown above the activity line. */
  thought: WorkItem | null;
  active: boolean;
};

function lastMatch<T>(list: readonly T[], test: (item: T) => boolean): T | undefined {
  for (let index = list.length - 1; index >= 0; index -= 1) if (test(list[index])) return list[index];
  return undefined;
}

export const LIVE_ACTIVITY_ROW_ID = "live-activity";

/**
 * The live row of a running turn's trailing tool group. `null` when the group has nothing to show, or its
 * latest tool failed (the web keeps the folded group and adds a Thinking row then).
 */
export function deriveLiveRow(groupId: string, items: readonly WorkItem[], isActive: (item: WorkItem) => boolean): { row: LiveRow | null; failed: boolean } {
  const visible = items.filter(liveEntryVisible);
  const latest = visible.at(-1);
  if (!latest) return { row: null, failed: false };
  const running = lastMatch(visible, isActive);
  const status = toolLifecycleStatus(latest.status);
  const failed = !running && (status === "failed" || (latest.type === "error"));
  if (failed) return { row: null, failed: true };
  const active = running !== undefined || status === "completed";
  const thought = lastMatch(visible, (item) => item.type === "reasoning" && item.detail.trim().length > 0) ?? null;
  return {
    row: {
      kind: "live",
      id: active ? LIVE_ACTIVITY_ROW_ID : `live:${groupId}`,
      groupId,
      items: visible,
      entry: running ?? latest,
      thought,
      active,
    },
    failed: false,
  };
}
