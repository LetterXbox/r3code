import type { PendingUserInput } from "../../store";

/**
 * ChatComposer isChoiceOnlyPendingQuestion (activeQuestion.allowCustomAnswer === false): the placeholder reads
 * "Choose an option above". The active question lives in UserInputPanel, so this holds when every question of the
 * first pending request is choice-only.
 */
export function isChoiceOnlyPendingInput(inputs: PendingUserInput[]): boolean {
  const first = inputs[0];
  return first !== undefined && first.questions.length > 0 && first.questions.every((question) => !question.allowCustomAnswer);
}
