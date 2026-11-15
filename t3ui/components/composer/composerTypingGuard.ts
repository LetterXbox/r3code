// chat/composerTypingGuard.ts: a request (approval, question) that arrives while the user is typing is held back
// until typing has been idle for a moment, so a keystroke meant for the composer never answers it.
export const COMPOSER_TYPING_IDLE_MS = 1500;

export function createComposerTypingGuardState() {
  return { seen: new Set<string>(), held: new Set<string>(), focused: false, lastTypedAt: -Infinity };
}

export type TypingGuardState = ReturnType<typeof createComposerTypingGuardState>;

type TypingGuardEvent =
  | { type: "requests"; requestIds: readonly string[]; now: number }
  | { type: "type"; now: number }
  | { type: "focus" | "blur" | "send" | "idle" };

export function updateComposerTypingGuard(state: TypingGuardState, event: TypingGuardEvent): TypingGuardState {
  switch (event.type) {
    case "requests": {
      const seen = new Set(state.seen);
      const held = new Set([...state.held].filter((id) => event.requestIds.includes(id)));
      for (const id of event.requestIds) {
        if (!seen.has(id) && state.focused && event.now - state.lastTypedAt < COMPOSER_TYPING_IDLE_MS) held.add(id);
        seen.add(id);
      }
      return { ...state, seen, held: held.size === state.held.size && [...held].every((id) => state.held.has(id)) ? state.held : held };
    }
    case "type":
      return { ...state, lastTypedAt: event.now };
    case "focus":
      return { ...state, focused: true };
    case "blur":
    case "send":
    case "idle":
      return { ...state, held: state.held.size === 0 ? state.held : new Set<string>(), lastTypedAt: -Infinity, focused: event.type === "blur" ? false : state.focused };
  }
}
