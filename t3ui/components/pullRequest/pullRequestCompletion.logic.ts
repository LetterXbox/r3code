// `@login`, `#123` and GitLab `!123` completion in pull request text (packages/shared pullRequestComposerTrigger.ts).
import type { Actor } from "./pullRequestDetail.logic";

export type CompletionSigil = "@" | "#" | "!";
export interface PullRequestComposerTrigger { kind: "mention" | "reference"; sigil: CompletionSigil; query: string; rangeStart: number; rangeEnd: number }

/** What the pull request's host can complete; absent fields complete nothing. */
export interface CompletionSupport { mentions?: boolean; referenceSigils?: readonly string[] }

export interface ReferenceCandidate { reference: string; kind: "issue" | "change-request"; number: number; title: string; state: "open" | "closed" | "merged" }
export type PullRequestCompletion =
  | { kind: "mention"; token: string; actor: Actor }
  | { kind: "reference"; token: string; candidate: ReferenceCandidate };

// Mentions cover GitHub logins and GitLab usernames (also `_` and `.`).
const TOKEN = /^(?:@([A-Za-z0-9_][A-Za-z0-9_.-]*)?|([#!])([\p{L}\p{N}_-]*))$/u;

/** The `@login`, `#123` or `!123` being typed at the caret, when the caret sits at its end and the host completes that sigil. */
export function detectPullRequestComposerTrigger(text: string, cursor: number, support: CompletionSupport): PullRequestComposerTrigger | null {
  const end = Math.max(0, Math.min(text.length, cursor));
  const next = text[end];
  if (next !== undefined && !/\s/.test(next)) return null;
  let start = end;
  while (start > 0 && !/\s/.test(text[start - 1] ?? "")) start -= 1;
  const match = TOKEN.exec(text.slice(start, end));
  if (!match) return null;
  const sigil = match[2];
  if (sigil === "#" || sigil === "!") return support.referenceSigils?.includes(sigil) ? { kind: "reference", sigil, query: match[3] ?? "", rangeStart: start, rangeEnd: end } : null;
  return support.mentions === true ? { kind: "mention", sigil: "@", query: match[1] ?? "", rangeStart: start, rangeEnd: end } : null;
}

/** Replaces the trigger with `token` and leaves the caret past the space after it. */
export function insertPullRequestCompletion(text: string, trigger: PullRequestComposerTrigger, token: string): { text: string; cursor: number } {
  const followedBySpace = /[ \t]/.test(text[trigger.rangeEnd] ?? "");
  const replacement = followedBySpace ? token : `${token} `;
  const next = `${text.slice(0, trigger.rangeStart)}${replacement}${text.slice(trigger.rangeEnd)}`;
  return { text: next, cursor: trigger.rangeStart + replacement.length + (followedBySpace ? 1 : 0) };
}

/** The key a debounce delays: the trigger's sigil and its host search, or null with no trigger. */
export const pullRequestCompletionKey = (trigger: Pick<PullRequestComposerTrigger, "sigil" | "query"> | null): string | null => trigger === null ? null : `${trigger.sigil}${trigger.query.slice(0, 100)}`;

/** The search to send for the trigger given a debounced key; until one for this sigil settles the host is asked for its unsearched list. */
export function debouncedPullRequestCompletionSearch(trigger: Pick<PullRequestComposerTrigger, "sigil">, debouncedKey: string | null): string | undefined {
  return debouncedKey?.startsWith(trigger.sigil) ? debouncedKey.slice(trigger.sigil.length) || undefined : undefined;
}

export function narrowPullRequestMentions(users: readonly Actor[], typed: string, limit: number): Actor[] {
  const needle = typed.toLowerCase();
  return users.filter((user) => user.login.toLowerCase().includes(needle) || user.name.toLowerCase().includes(needle)).slice(0, limit);
}

/** Candidates the typed sigil links, by number prefix or title. */
export function narrowPullRequestReferences(candidates: readonly ReferenceCandidate[], trigger: Pick<PullRequestComposerTrigger, "sigil" | "query">, limit: number): ReferenceCandidate[] {
  const needle = trigger.query.toLowerCase();
  return candidates.filter((candidate) => candidate.reference.startsWith(trigger.sigil) && (String(candidate.number).startsWith(needle) || candidate.title.toLowerCase().includes(needle))).slice(0, limit);
}

/** The host's options for the trigger, narrowed to what is typed now. */
export function pullRequestCompletions(trigger: PullRequestComposerTrigger | null, options: { authors: readonly Actor[]; references: readonly ReferenceCandidate[] } | null, limit: number): PullRequestCompletion[] {
  if (trigger === null) return [];
  return trigger.kind === "mention"
    ? narrowPullRequestMentions(options?.authors ?? [], trigger.query, limit).map((actor) => ({ kind: "mention" as const, token: `@${actor.login}`, actor }))
    : narrowPullRequestReferences(options?.references ?? [], trigger, limit).map((candidate) => ({ kind: "reference" as const, token: candidate.reference, candidate }));
}

/** The `pullRequests.filterOptions` input for a trigger (PullRequestFilterOptionsInput). */
export function completionOptionsInput(trigger: PullRequestComposerTrigger, projectId: string, search: string | undefined, host?: string) {
  return trigger.kind === "mention"
    ? { kind: "authors", projectId, ...(host ? { host } : {}), ...(search ? { query: search } : {}) }
    : { kind: "references", projectId, ...(host ? { host } : {}), sigil: trigger.sigil, ...(search ? { query: search } : {}) };
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** PullRequestFilterOptions: the authors and reference candidates a host answered with. */
export function parseCompletionOptions(value: unknown): { authors: Actor[]; references: ReferenceCandidate[] } {
  const body = isRecord(value) ? value : {};
  const authors = (Array.isArray(body.authors) ? body.authors : []).flatMap((entry): Actor[] => isRecord(entry) && text(entry.login) ? [{ login: text(entry.login), name: text(entry.name), avatarUrl: text(entry.avatarUrl) }] : []);
  const references = (Array.isArray(body.references) ? body.references : []).flatMap((entry): ReferenceCandidate[] => {
    if (!isRecord(entry) || !text(entry.reference) || typeof entry.number !== "number") return [];
    const state = entry.state === "closed" || entry.state === "merged" ? entry.state : "open";
    return [{ reference: text(entry.reference), kind: entry.kind === "issue" ? "issue" : "change-request", number: entry.number, title: text(entry.title), state }];
  });
  return { authors, references };
}
