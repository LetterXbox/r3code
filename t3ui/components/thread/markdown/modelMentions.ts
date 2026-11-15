// `model:<instance>/<model>` references (client-runtime composerModelMentions.ts): the text the composer writes when a model is
// mentioned, which a sent message draws as a chip (ModelMentionChip.tsx). Pure: no store, no rendering.

export interface ModelMentionOccurrence { instanceId: string; model: string; source: string; start: number; end: number }

/** What a mention chip shows (ModelMentionChip.tsx ModelMentionPresentation). */
export interface ModelMentionPresentation {
  label: string;
  providerLabel: string;
  driver: string;
  providerDisplayName: string;
  accentColor: string | null;
  instanceId: string;
}

/** Writes a mention: no `@`, which the editor would turn into a file chip. */
export const formatComposerModelMention = (instanceId: string, model: string): string => `model:${instanceId}/${model}`;

// Instance ids match ProviderInstanceId; model slugs may contain `/`, as in `opencode/anthropic/opus`.
const MODEL_MENTION_PATTERN = /(?<![^\s,(["'])model:([a-zA-Z][a-zA-Z0-9_-]*)\/([^\s,"']+)/gu;
const SENTENCE_PUNCTUATION = ".;:!?";
const CLOSING_BRACKETS: Readonly<Record<string, string>> = { ")": "(", "]": "[" };

const countOf = (text: string, char: string): number => text.split(char).length - 1;

// Slugs like `foo(bar)` or `GPT-6.1-Sol[1m]` keep balanced brackets; prose wrapping them does not.
function trimModelSlug(slug: string): string {
  let trimmed = slug;
  while (trimmed.length > 0) {
    const last = trimmed.at(-1)!;
    const opening = CLOSING_BRACKETS[last];
    const unbalanced = opening !== undefined && countOf(trimmed, opening) < countOf(trimmed, last);
    if (!SENTENCE_PUNCTUATION.includes(last) && !unbalanced) break;
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

/** collectComposerModelMentions: finds the references `formatComposerModelMention` writes. */
export function collectComposerModelMentions(text: string): ModelMentionOccurrence[] {
  if (!text.includes("model:")) return [];
  const found: ModelMentionOccurrence[] = [];
  for (const match of text.matchAll(MODEL_MENTION_PATTERN)) {
    const instanceId = match[1]!;
    const model = trimModelSlug(match[2]!);
    if (model.length === 0) continue;
    const start = match.index ?? 0;
    const end = start + "model:".length + instanceId.length + 1 + model.length;
    found.push({ instanceId, model, source: text.slice(start, end), start, end });
  }
  return found;
}
