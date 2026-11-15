// Port of detectComposerTrigger (apps/web/src/composer-logic.ts): `/` slash commands, `@`
// file/folder mentions, `#` pull requests and `$` (any currency sign) provider skills.
export type ComposerTriggerKind = "path" | "slash-command" | "skill" | "pull-request";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

const isWhitespace = (char: string) => char === " " || char === "\n" || char === "\t" || char === "\r";

function tokenStartForCursor(text: string, cursor: number): number {
  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? "")) index -= 1;
  return index + 1;
}

/** A second slash makes the whole word a path, even when the caret precedes that slash. */
function isPathWord(text: string, wordStart: number, cursor: number): boolean {
  let wordEnd = cursor;
  while (wordEnd < text.length && !isWhitespace(text[wordEnd] ?? "")) wordEnd += 1;
  return text.slice(wordStart + 1, wordEnd).includes("/");
}

/** `$5`, `$10k`, `($5)`: an amount, not a skill query (shared/composerTrigger.ts). */
export function isCurrencyAmountQuery(query: string): boolean {
  return /^\.?[0-9][0-9,._]*(?:[kKmMbBtT]|[eE][0-9]+)?[.,;:!?)]*$/.test(query);
}

export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = Number.isFinite(cursorInput) ? Math.max(0, Math.min(text.length, Math.floor(cursorInput))) : text.length;
  const tokenStart = tokenStartForCursor(text, cursor);
  const token = text.slice(tokenStart, cursor);
  if (token.startsWith("/")) {
    if (isPathWord(text, tokenStart, cursor)) return null;
    return { kind: "slash-command", query: token.slice(1), rangeStart: tokenStart, rangeEnd: cursor };
  }
  const pullRequest = /^#([\p{L}\p{N}][\p{L}\p{N}_-]*)?$/u.exec(token);
  if (pullRequest) return { kind: "pull-request", query: pullRequest[1] ?? "", rangeStart: tokenStart, rangeEnd: cursor };
  const skillPrefix = /^\p{Sc}/u.exec(token);
  if (skillPrefix) {
    const query = token.slice(skillPrefix[0].length);
    if (isCurrencyAmountQuery(query)) return null;
    return { kind: "skill", query, rangeStart: tokenStart, rangeEnd: cursor };
  }
  if (token.startsWith("@")) return { kind: "path", query: token.slice(1), rangeStart: tokenStart, rangeEnd: cursor };
  return null;
}

/** Pasting into an active `@` query extends it by the pasted text's first word (pastedPathQueryLength, composer-logic.ts). */
export function pastedPathQueryLength(lineBefore: string, pasted: string, pathQueryActive = true): number {
  if (!pathQueryActive) return 0;
  if (detectComposerTrigger(lineBefore, lineBefore.length)?.kind !== "path") return 0;
  return /^\S*/.exec(pasted)![0].length;
}

/** The text with the trigger's range replaced, and where the caret lands. */
export function applyReplacement(text: string, trigger: ComposerTrigger, replacement: string): { text: string; cursor: number } {
  // A replacement ending in a space swallows one space already after the range (no double space).
  const rangeEnd = replacement.endsWith(" ") && text[trigger.rangeEnd] === " " ? trigger.rangeEnd + 1 : trigger.rangeEnd;
  const next = text.slice(0, trigger.rangeStart) + replacement + text.slice(rangeEnd);
  return { text: next, cursor: trigger.rangeStart + replacement.length };
}

/** `/clear` as the whole message arms a fresh session instead of sending (shared composerTrigger.ts). */
export function isClearComposerCommand(text: string): boolean {
  return /^\/clear\s*$/i.test(text.trim());
}

/** `/side [prompt]`, or its alias `/btw [prompt]`, as the whole message. */
export function parseSideChatCommand(text: string): { prompt: string } | null {
  const match = /^\/(?:side|btw)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { prompt: match[1]?.trim() ?? "" } : null;
}
