// MessagesTimeline.logic.ts resolveAssistantMessageCopyState / deriveTerminalAssistantMessageIds:
// an assistant message shows its copy button only when it is the last assistant reply of its turn and
// it is not streaming; the copied text renders Codex directives as plain markdown.
import type { Message } from "../../store";
import { renderCodexDirectivesForCopy } from "./markdown/codexDirectives";

export function terminalAssistantMessageIds(messages: ReadonlyArray<Pick<Message, "id" | "role" | "runId">>): Set<string> {
  const lastByResponse = new Map<string, string>();
  let nullTurnResponseIndex = 0;
  for (const message of messages) {
    if (message.role === "user") { nullTurnResponseIndex += 1; continue; }
    if (message.role !== "assistant") continue;
    lastByResponse.set(message.runId ? `turn:${message.runId}` : `unkeyed:${nullTurnResponseIndex}`, message.id);
  }
  return new Set(lastByResponse.values());
}

export function resolveAssistantMessageCopyState(input: { text: string | null; showCopyButton: boolean; streaming: boolean }): { text: string | null; visible: boolean } {
  const hasText = input.text !== null && input.text.trim().length > 0;
  const visible = input.showCopyButton && hasText && !input.streaming;
  return { text: hasText ? (visible ? renderCodexDirectivesForCopy(input.text!) : input.text) : null, visible };
}
