import { expect, test } from "nsh/test";
import { resolveAssistantMessageCopyState, terminalAssistantMessageIds } from "./assistantCopy";

test("only the last assistant message of each turn is terminal", () => {
  const ids = terminalAssistantMessageIds([
    { id: "u1", role: "user" }, { id: "a1", role: "assistant", runId: "r1" }, { id: "a2", role: "assistant", runId: "r1" },
    { id: "u2", role: "user" }, { id: "a3", role: "assistant" }, { id: "a4", role: "assistant" },
  ]);
  expect([...ids].sort()).toEqual(["a2", "a4"]);
});

test("copy hides while streaming or off the terminal reply", () => {
  expect(resolveAssistantMessageCopyState({ text: "hi", showCopyButton: true, streaming: true }).visible).toBe(false);
  expect(resolveAssistantMessageCopyState({ text: "hi", showCopyButton: false, streaming: false }).visible).toBe(false);
  expect(resolveAssistantMessageCopyState({ text: "  ", showCopyButton: true, streaming: false })).toEqual({ text: null, visible: false });
  expect(resolveAssistantMessageCopyState({ text: "hi", showCopyButton: true, streaming: false })).toEqual({ text: "hi", visible: true });
});
