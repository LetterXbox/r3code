import { expect, test } from "nsh/test";
import { COMPOSER_TYPING_IDLE_MS, createComposerTypingGuardState, updateComposerTypingGuard } from "./composerTypingGuard";

test("a request that arrives while the user is typing is held until typing goes idle", () => {
  let state = createComposerTypingGuardState();
  state = updateComposerTypingGuard(state, { type: "focus" });
  state = updateComposerTypingGuard(state, { type: "type", now: 1000 });
  state = updateComposerTypingGuard(state, { type: "requests", requestIds: ["approval:1"], now: 1000 + COMPOSER_TYPING_IDLE_MS - 1 });
  expect([...state.held]).toEqual(["approval:1"]);
  state = updateComposerTypingGuard(state, { type: "idle" });
  expect(state.held.size).toBe(0);
});

test("a request that arrives while the user is not typing, or after a long pause, is not held", () => {
  let state = updateComposerTypingGuard(createComposerTypingGuardState(), { type: "requests", requestIds: ["a"], now: 5 });
  expect(state.held.size).toBe(0);
  state = updateComposerTypingGuard(state, { type: "focus" });
  state = updateComposerTypingGuard(state, { type: "type", now: 10 });
  state = updateComposerTypingGuard(state, { type: "requests", requestIds: ["a", "b"], now: 10 + COMPOSER_TYPING_IDLE_MS });
  expect(state.held.size).toBe(0);
});
