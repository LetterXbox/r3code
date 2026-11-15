// chat/useComposerTypingGuard.ts over signals: `held()` names the request ids the panels should keep back.
import { cleanup, effect, signal } from "nsh";
import { COMPOSER_TYPING_IDLE_MS, createComposerTypingGuardState, updateComposerTypingGuard } from "./composerTypingGuard";

export function useComposerTypingGuard(scope: () => string, requestIds: () => readonly string[]) {
  const state = signal(createComposerTypingGuardState());
  let lastScope = scope();
  const dispatch = (event: Parameters<typeof updateComposerTypingGuard>[1]) => state.update((current) => updateComposerTypingGuard(current, event));
  effect(() => {
    const ids = requestIds();
    const current = scope();
    state.update((existing) => {
      const base = current === lastScope ? existing : { ...createComposerTypingGuardState(), focused: existing.focused };
      lastScope = current;
      return updateComposerTypingGuard(base, { type: "requests", requestIds: ids, now: Date.now() });
    });
  });
  effect(() => {
    const { held, lastTypedAt } = state();
    if (held.size === 0) return;
    const timeout = setTimeout(() => dispatch({ type: "idle" }), Math.max(0, lastTypedAt + COMPOSER_TYPING_IDLE_MS - Date.now()));
    return () => clearTimeout(timeout);
  });
  cleanup(() => { /* timers are cleared by their effect */ });
  return {
    held: () => state().held as ReadonlySet<string>,
    onDraftChange: () => dispatch({ type: "type", now: Date.now() }),
    onFocus: () => dispatch({ type: "focus" }),
    onBlur: () => dispatch({ type: "blur" }),
    onSend: () => dispatch({ type: "send" }),
  };
}
