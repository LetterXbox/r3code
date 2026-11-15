// Hover details for inline tokens (WorkspaceEntryTooltip, the chips' tooltips). The port's prompt editor has no hover
// API, so the details of the token beside the caret show in a status line under the composer instead (port-specific).
import { collectPromptTokens } from "./editor/promptDocument";
import type { PromptToken, PromptTokenContext } from "./editor/promptDocument";
import { contextDetailFor } from "./contextChips";

/** The token the caret touches (inside it or right after it), if any. */
export function tokenAtCaret(text: string, caret: number, context: PromptTokenContext): PromptToken | null {
  return collectPromptTokens(text, context).find((token) => caret >= token.start && caret <= token.end) ?? null;
}

/** What the status line says about a token, or null when there is nothing to add to its label. */
export function tokenDetail(token: PromptToken, threadId: string | undefined, context: PromptTokenContext): string | null {
  switch (token.kind) {
    case "file": case "folder": return token.value;
    case "skill": return `Skill: ${context.skills.get(token.value) || token.value}`;
    case "model": return `Model: ${token.value}`;
    case "thread": case "terminal": return contextDetailFor(threadId, token.kind, token.value);
    case "pull-request": return `Pull request ${token.value}`;
    default: return null;
  }
}

export const tokenDetailAt = (text: string, caret: number, threadId: string | undefined, context: PromptTokenContext): string | null => {
  const token = tokenAtCaret(text, caret, context);
  return token ? tokenDetail(token, threadId, context) : null;
};
