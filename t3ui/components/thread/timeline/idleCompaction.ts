// Port of the idle / resume compaction titles (MessagesTimeline.logic.ts compactionRuns / compactionTitle,
// client-runtime userMessage.ts IDLE_COMPACTION_TITLES / IDLE_COMPACTING_LABELS, contracts idleCompactionOf,
// shared claudeCompaction.ts claudeResumeCompactionAge). Pure: no nsh imports.
import { readQuestionAnswer } from "./questionAnswer";

export type IdleCompaction = "beforeCacheExpires" | "onReturn";

/** Live label while T3 Code compacts on its own (replaces "Compacting context"). */
export const IDLE_COMPACTING_LABELS: Record<IdleCompaction, string> = {
  beforeCacheExpires: "Compacting before the cache expires…",
  onReturn: "Compacting…",
};

/** Leads the finished compaction's token counts, in place of "Context compacted". */
export const IDLE_COMPACTION_TITLES: Record<IdleCompaction, string> = {
  beforeCacheExpires: "Context automatically compacted before cache expiry",
  onReturn: "Context compacted before sending",
};

export const CLAUDE_RESUME_COMPACTION_COMPACT_ANSWER = "Compact and continue";
const CLAUDE_RESUME_COMPACTION_QUESTION_PATTERN = /^This session is (\d+h \d+m|\d+m) old and uses \d{1,3}(?:,\d{3})* tokens\. Compact it before continuing\?$/u;

/** contracts isCompactionCommandMessage: a lone `/compact` prompt with no attachments. */
export function isCompactionCommandMessage(message: { body: string; attachments?: readonly unknown[] }): boolean {
  return (message.attachments?.length ?? 0) === 0 && /^\/compact(?:\s|$)/i.test(message.body.trim());
}

/** contracts idleCompactionOf: why T3 Code sent this `/compact` itself, or undefined for one someone asked for. */
export function idleCompactionOf(message: { body: string; attachments?: readonly unknown[]; idleCompaction?: string; createdBy?: string; creationSource?: string }): IdleCompaction | undefined {
  if (!isCompactionCommandMessage(message)) return undefined;
  if (message.idleCompaction === "beforeCacheExpires" || message.idleCompaction === "onReturn") return message.idleCompaction;
  // Servers before `idleCompaction` marked their own as agent-created.
  return message.createdBy === "agent" && message.creationSource === "server" ? "beforeCacheExpires" : undefined;
}

/** claudeResumeCompactionAge: the session age from an answered resume question whose answer was to compact, or null. */
export function claudeResumeCompactionAge(questionAnswer: unknown): string | null {
  const answer = readQuestionAnswer(questionAnswer);
  if (!answer) return null;
  for (const [id, value] of Object.entries(answer.answers)) {
    const age = CLAUDE_RESUME_COMPACTION_QUESTION_PATTERN.exec(answer.questionTextById?.[id] ?? id)?.[1];
    const chosen = Array.isArray(value) ? value : [value];
    if (age !== undefined && chosen.includes(CLAUDE_RESUME_COMPACTION_COMPACT_ANSWER)) return age;
  }
  return null;
}

type Entry =
  | { kind: "message"; id: string; message: { body: string; runId?: string; attachments?: readonly unknown[]; idleCompaction?: string; createdBy?: string; creationSource?: string } }
  | { kind: "activity"; id: string; activity: { type: string; item?: Record<string, unknown> } };

export interface CompactionTitles {
  /** The finished divider's title (replaces "Context compacted"), by compaction entry id. */
  title(entryId: string, runId: string | undefined): string | undefined;
  /** The live label of an idle compaction's run, else undefined. */
  activeLabel(runId: string | undefined): string | undefined;
  /** An answered "compact before continuing?" question folded into the compaction it asked for. */
  foldsQuestion(item: { type: string; item?: Record<string, unknown> }): boolean;
}

/** MessagesTimeline.logic.ts compactionRuns / compactedRunIds / resumeCompactionAgeByEntryId over the timeline entries. */
export function compactionTitles(entries: readonly Entry[]): CompactionTitles {
  const runs = new Map<string, IdleCompaction | undefined>();
  const compacted = new Set<string>();
  const pendingAge = new Map<string, string>();
  const ageByEntry = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind === "message") {
      if (entry.message.runId && isCompactionCommandMessage(entry.message)) runs.set(entry.message.runId, idleCompactionOf(entry.message));
      continue;
    }
    const runId = typeof entry.activity.item?.runId === "string" ? entry.activity.item.runId : undefined;
    if (!runId) continue;
    if (entry.activity.type === "compaction") {
      compacted.add(runId);
      const age = pendingAge.get(runId);
      if (age !== undefined) { ageByEntry.set(entry.id, age); pendingAge.delete(runId); }
    }
    const age = entry.activity.item?.questionAnswer ? claudeResumeCompactionAge(entry.activity.item.questionAnswer) : null;
    if (age !== null) pendingAge.set(runId, age);
  }
  return {
    title(entryId, runId) {
      if (!runId) return undefined;
      const reason = runs.get(runId);
      if (reason !== undefined) return IDLE_COMPACTION_TITLES[reason];
      const age = ageByEntry.get(entryId);
      return age ? `Context compacted after ${age} idle` : undefined;
    },
    activeLabel(runId) {
      const reason = runId ? runs.get(runId) : undefined;
      return reason ? IDLE_COMPACTING_LABELS[reason] : undefined;
    },
    foldsQuestion(item) {
      const runId = typeof item.item?.runId === "string" ? item.item.runId : undefined;
      return runId !== undefined && compacted.has(runId) && item.item?.questionAnswer !== undefined && claudeResumeCompactionAge(item.item.questionAnswer) !== null;
    },
  };
}

/** ContextCompactionTimelineRow: the title replaces the leading "Context compacted" of the label. */
export function titledCompactionLabel(label: string, title: string | undefined): string {
  return title && label.startsWith("Context compacted") ? title + label.slice("Context compacted".length) : label;
}
