// usePromptSuggestion: the provider's predicted next prompt (orchestration.subscribePromptSuggestion, an
// OrchestrationV2PromptSuggestion), offered while the run that produced it is the thread's latest run, completed, and
// Escape has not dismissed it. Dismissals are shared by every composer, keyed by environment and run.
import { signal } from "nsh";

export interface PromptSuggestion { runId: string; text: string }

export function parsePromptSuggestion(value: unknown): PromptSuggestion | null {
  const item = value as { runId?: unknown; text?: unknown } | null;
  return item && typeof item.runId === "string" && typeof item.text === "string" && item.text.trim() ? { runId: item.runId, text: item.text } : null;
}

const dismissed = signal<ReadonlySet<string>>(new Set());
const key = (environment: string, runId: string) => `${environment}\0${runId}`;

export function offeredSuggestion(input: { environment: string; data: PromptSuggestion | null; latestRun: { id: string; status: string } | null }): string | null {
  const { data, latestRun } = input;
  if (!data || !latestRun || latestRun.id !== data.runId || latestRun.status !== "completed") return null;
  return dismissed().has(key(input.environment, data.runId)) ? null : data.text;
}

export function dismissSuggestion(environment: string, runId: string): void {
  dismissed.set(new Set(dismissed()).add(key(environment, runId)));
}
