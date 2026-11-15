// Pure state for the pending-question banner: ported from pendingUserInput.ts
// (derivePendingUserInputProgress) and ComposerPrimaryActions.tsx (the primary label).
import type { UserInputQuestion } from "../../store";

export type Answer = string | string[];
export interface DraftAnswer {
  customAnswer?: string;
  selectedOptions?: string[];
}

export function resolveAnswer(question: UserInputQuestion, draft: DraftAnswer | undefined): Answer | null {
  const custom = question.allowCustomAnswer === false
    ? null
    : question.initialAnswer !== undefined
      ? draft?.customAnswer ?? question.initialAnswer
      : draft?.customAnswer?.trim() || null;
  if (custom !== null && custom.length > 0) return custom;
  const selected = draft?.selectedOptions ?? [];
  if (selected.length > 0) return question.multiSelect ? selected : selected[0];
  return custom;
}

export interface Progress {
  questionIndex: number;
  activeQuestion: UserInputQuestion | null;
  selectedValues: string[];
  customAnswer: string;
  answeredCount: number;
  isLastQuestion: boolean;
  isComplete: boolean;
  canAdvance: boolean;
}

export function deriveProgress(questions: readonly UserInputQuestion[], drafts: Record<string, DraftAnswer>, questionIndex: number): Progress {
  const index = questions.length === 0 ? 0 : Math.max(0, Math.min(questionIndex, questions.length - 1));
  const activeQuestion = questions[index] ?? null;
  const draft = activeQuestion ? drafts[activeQuestion.id] : undefined;
  const customAnswer = activeQuestion?.allowCustomAnswer === false ? "" : draft?.customAnswer ?? "";
  const answered = questions.filter((question) => resolveAnswer(question, drafts[question.id]) !== null);
  return {
    questionIndex: index,
    activeQuestion,
    selectedValues: draft?.selectedOptions ?? [],
    customAnswer,
    answeredCount: answered.length,
    isLastQuestion: questions.length === 0 ? true : index >= questions.length - 1,
    isComplete: answered.length === questions.length,
    canAdvance: activeQuestion ? resolveAnswer(activeQuestion, draft) !== null : false,
  };
}

/** A typed answer displaces the selected option, as the web's customAnswerActive does. */
export function optionSelected(progress: Progress, value: string): boolean {
  const custom = progress.activeQuestion?.initialAnswer !== undefined ? progress.customAnswer : progress.customAnswer.trim();
  return custom.length === 0 && progress.selectedValues.includes(value);
}

/** Digit shortcuts 1 to 9 pick the matching option; anything else is not a shortcut. */
export function optionForDigit(question: UserInputQuestion | null, key: string): string | null {
  const digit = Number.parseInt(key, 10);
  if (!question || Number.isNaN(digit) || digit < 1 || digit > 9) return null;
  const option = question.options[digit - 1];
  return option ? option.value ?? option.label : null;
}

/** composerFooterLayout.ts:2,29-41: with the pending-answer actions (the wide ones) the footer goes compact under 780 pt. */
export const COMPACT_PRIMARY_ACTIONS_BREAKPOINT = 780;
export function isCompactPrimaryActions(width: number | null): boolean {
  return width !== null && width < COMPACT_PRIMARY_ACTIONS_BREAKPOINT;
}

/** ComposerPrimaryActions.tsx:55-69 formatPendingPrimaryActionLabel: compact reads "Submit" and "Next". */
export function primaryLabel(progress: Progress, responding: boolean, compact = false): string {
  if (responding) return "Submitting...";
  if (compact) return progress.isLastQuestion ? "Submit" : "Next";
  if (!progress.isLastQuestion) return "Next question";
  return progress.questionIndex > 0 ? "Submit answers" : "Submit answer";
}

export function toggleSelection(question: UserInputQuestion, previous: DraftAnswer | undefined, value: string): DraftAnswer {
  const selected = previous?.selectedOptions ?? [];
  const next = question.multiSelect
    ? selected.includes(value) ? selected.filter((entry) => entry !== value) : [...selected, value]
    : [value];
  return { customAnswer: "", selectedOptions: next };
}

export function withCustomAnswer(question: UserInputQuestion, previous: DraftAnswer | undefined, value: string): DraftAnswer {
  const keepSelection = question.initialAnswer === undefined && value.trim().length === 0;
  return { customAnswer: value, ...(keepSelection && previous?.selectedOptions ? { selectedOptions: previous.selectedOptions } : {}) };
}

/** carryDisplacedCustomAnswerIntoPrompt (pendingUserInput.ts:51): text typed as a custom answer that an option replaces goes back to the draft. */
export function carryDisplacedCustomAnswerIntoPrompt(prompt: string, customAnswer: string | undefined): string {
  const displaced = customAnswer?.trim() ?? "";
  if (displaced.length === 0) return prompt;
  if (prompt.trim().length === 0) return displaced;
  return `${prompt.trimEnd()}\n\n${displaced}`;
}
