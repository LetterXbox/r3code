// Port of composerPromptHistory.ts: Up recalls earlier user messages, Down walks forward again
// and past the newest returns to an empty composer.
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT, resolveUserMessagePresentation } from "../thread/timeline/userMessagePresentation";
import type { Message } from "../../store";

/** proposedPlan.ts PLAN_IMPLEMENTATION_PROMPT_PREFIX: an "Implement plan" send, which recall skips. */
export const PLAN_IMPLEMENTATION_PROMPT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:\n";

export interface PromptHistoryEntry { id: string; prompt: string }
export interface PromptHistoryPosition { entryId: string; recalled: string }
export interface PromptHistoryStep { position: PromptHistoryPosition | null; prompt: string }

const CLAUDE_ULTRATHINK_PREFIX = "Ultrathink:\n";
const REVIEW_COMMENT_BLOCK_PATTERN = /<review_comment\b[^>]*>[\s\S]*?<\/review_comment>/g;
const TRAILING_LEGACY_CONTEXT = /\n*<(terminal_context|element_context|preview_annotation)>\n([\s\S]*?)\n<\/\1>\s*$/;
// collectComposerContextReferences: `[label](t3-context://v1/<kind>/<id>)` chips.
const CONTEXT_REFERENCE = /!?\[(?:\\.|[^\]\\]){0,200}\]\(t3-context:\/\/v1\/[a-z-]+\/[A-Za-z0-9_-]{1,128}\)/g;

function stripTrailingReviewComments(prompt: string): string {
  let cut = prompt.length;
  for (const match of [...prompt.matchAll(REVIEW_COMMENT_BLOCK_PATTERN)].reverse()) {
    const blockEnd = (match.index ?? 0) + match[0].length;
    if (prompt.slice(blockEnd, cut).trim().length > 0) break;
    cut = match.index ?? 0;
  }
  return cut === prompt.length ? prompt : prompt.slice(0, cut).trimEnd();
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function stripInlineTerminalLabels(prompt: string, headers: readonly string[]): string {
  let result = prompt;
  for (const header of headers) {
    const match = /^(.+?) lines? (\d+(?:-\d+)?)$/.exec(header);
    if (!match) continue;
    const label = `@${match[1]!.trim().toLowerCase().replace(/\s+/g, "-")}:${match[2]}`;
    const index = result.search(new RegExp(`(?<![\\w@.-])${escapeRegExp(label)}(?![\\d-])`));
    if (index < 0) continue;
    let end = index + label.length;
    let start = index;
    if (result[end] === " ") end += 1;
    else if (result[start - 1] === " ") start -= 1;
    result = result.slice(0, start) + result.slice(end);
  }
  return result;
}

/** recallableComposerPrompt: the text a recall puts back, without the Ultrathink prefix, trailing review comments,
 * legacy context blocks, context chips (their records are gone), the attachment-only bootstrap and plan sends. */
export function recallableComposerPrompt(messageText: string): string {
  let prompt = messageText.trim();
  if (prompt.startsWith(CLAUDE_ULTRATHINK_PREFIX)) prompt = prompt.slice(CLAUDE_ULTRATHINK_PREFIX.length);
  while (prompt.length > 0) {
    const withoutReviewComments = stripTrailingReviewComments(prompt);
    if (withoutReviewComments !== prompt) { prompt = withoutReviewComments; continue; }
    const legacy = TRAILING_LEGACY_CONTEXT.exec(prompt);
    if (legacy) {
      if (legacy[1] === "preview_annotation" && /^<preview_annotation>\s*$/m.test(legacy[2]!) && !/^(?:Id|Page|Comment|Targets): /m.test(legacy[2]!)) break;
      const headers = Array.from(legacy[2]!.matchAll(/^- (.+):$/gm), (match) => match[1]!);
      if (legacy[1] !== "preview_annotation" && headers.length === 0) break;
      prompt = prompt.slice(0, legacy.index).trimEnd();
      if (legacy[1] === "terminal_context") prompt = stripInlineTerminalLabels(prompt, headers);
      continue;
    }
    break;
  }
  for (const reference of [...prompt.matchAll(CONTEXT_REFERENCE)].reverse()) {
    let start = reference.index ?? 0;
    let end = start + reference[0].length;
    if (prompt[end] === " ") end += 1;
    else if (prompt[start - 1] === " ") start -= 1;
    prompt = prompt.slice(0, start) + prompt.slice(end);
  }
  const trimmed = prompt.trim();
  return trimmed === ATTACHMENT_ONLY_BOOTSTRAP_PROMPT || trimmed.startsWith(PLAN_IMPLEMENTATION_PROMPT_PREFIX) ? "" : trimmed;
}

type HistoryMessage = Pick<Message, "id" | "role" | "body"> & Partial<Pick<Message, "createdBy" | "creationSource" | "scheduledTaskId" | "context">>;

export function buildPromptHistoryEntries(messages: HistoryMessage[]): PromptHistoryEntry[] {
  const entries: PromptHistoryEntry[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    // Automations and other agents send user-role messages; recall only what the user typed.
    if (resolveUserMessagePresentation(message).attribution !== null) continue;
    const prompt = recallableComposerPrompt(message.body);
    if (prompt.length === 0) continue;
    const previous = entries[entries.length - 1];
    // Resending the same prompt collapses into one entry.
    if (previous && previous.prompt === prompt) { entries[entries.length - 1] = { id: message.id, prompt }; continue; }
    entries.push({ id: message.id, prompt });
  }
  return entries;
}

function findActive(entries: PromptHistoryEntry[], position: PromptHistoryPosition): number {
  const byId = entries.findIndex((entry) => entry.id === position.entryId);
  if (byId >= 0) return byId;
  for (let index = entries.length - 1; index >= 0; index -= 1) if (entries[index]!.prompt === position.recalled) return index;
  return -1;
}

export function stepPromptHistory(input: {
  direction: "backward" | "forward";
  entries: PromptHistoryEntry[];
  position: PromptHistoryPosition | null;
  currentPrompt: string;
}): PromptHistoryStep | null {
  const { entries, position, currentPrompt } = input;
  const activeIndex = position && position.recalled === currentPrompt ? findActive(entries, position) : -1;
  if (input.direction === "backward") {
    if (activeIndex < 0 && currentPrompt.length > 0) return null;
    const entry = entries[activeIndex < 0 ? entries.length - 1 : activeIndex - 1];
    if (!entry) return null;
    return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
  }
  if (activeIndex < 0) return null;
  const entry = entries[activeIndex + 1];
  if (!entry) return { position: null, prompt: "" };
  return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
}
