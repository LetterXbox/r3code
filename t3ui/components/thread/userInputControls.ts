import { signal } from "nsh";

/** The active question's controls, shared with its thread's composer. */
export interface ComposerQuestionControls {
  text: string;
  allowCustomAnswer: boolean;
  isLast: boolean;
  canAdvance: boolean;
  canGoBack: boolean;
  responding: boolean;
  setText: (text: string) => void;
  advance: () => void;
  previous: () => void;
}

const controls = signal<Record<string, ComposerQuestionControls>>({});
export const composerQuestionControls = (scope: string) => controls()[scope] ?? null;
export function setComposerQuestionControls(scope: string, value: ComposerQuestionControls | null) {
  controls.update((current) => {
    if (value) return { ...current, [scope]: value };
    const { [scope]: _removed, ...rest } = current;
    return rest;
  });
}
