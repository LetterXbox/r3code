// packages/client-runtime userMessage.ts, ported: who a user message is from (the reader, another agent, an automation, a
// guest, T3 Code itself), what text people see for it, and how consecutive messages group. MessageRow draws the variants.
import type { Message } from "../../../store";

/** packages/shared composerContextReferences: the prompt the agent gets when only attachments were sent. */
export const ATTACHMENT_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]";
export const isAttachmentOnlyBootstrapPrompt = (text: string) => text.replace(/^Ultrathink:\s*/i, "") === ATTACHMENT_ONLY_BOOTSTRAP_PROMPT;

const LEGACY_AUTOMATION_PREFIX = /^\[Triggered by schedule task: [^\r\n]+\]\r?\n\r?\n/;
const LEGACY_AUTOMATION_MESSAGE_ID = /^scheduled-task-message:(.+):\d+:(?:scheduled|manual)$/;

export type UserMessageAttribution = "automation" | "agent" | "t3code" | "guest" | null;
export interface UserMessagePresentation {
  text: string;
  attribution: UserMessageAttribution;
  scheduledTaskId: string | undefined;
  /** Set when `attribution` is "guest". */
  guestName?: string;
}

type PresentationInput = Pick<Message, "role" | "body"> & Partial<Pick<Message, "id" | "createdBy" | "creationSource" | "scheduledTaskId" | "context" | "inputIntent">>;

function guestOf(context: unknown): { name: string; text: string } | null {
  if (typeof context !== "object" || context === null) return null;
  const guest = (context as { guest?: unknown }).guest;
  if (typeof guest !== "object" || guest === null) return null;
  const { name, text } = guest as { name?: unknown; text?: unknown };
  return typeof name === "string" && typeof text === "string" ? { name, text } : null;
}

/** resolveUserMessagePresentation. */
export function resolveUserMessagePresentation(message: PresentationInput): UserMessagePresentation {
  if (message.role !== "user") return { text: message.body, attribution: null, scheduledTaskId: undefined };
  // The stored text names the guest for the agent; people see the guest's own words.
  const guest = guestOf(message.context);
  if (guest) return { text: guest.text, attribution: "guest", scheduledTaskId: undefined, guestName: guest.name };
  if (message.scheduledTaskId !== undefined) return { text: message.body, attribution: "automation", scheduledTaskId: message.scheduledTaskId };
  const legacyPrefix = LEGACY_AUTOMATION_PREFIX.exec(message.body);
  const legacyTaskId = legacyPrefix ? LEGACY_AUTOMATION_MESSAGE_ID.exec(message.id ?? "")?.[1] : undefined;
  if (legacyPrefix !== null && (legacyTaskId !== undefined || message.createdBy === "agent")) {
    return { text: message.body.slice(legacyPrefix[0].length), attribution: "automation", scheduledTaskId: legacyTaskId };
  }
  return {
    // The agent needs words to start a turn; people sent only the attachments.
    text: isAttachmentOnlyBootstrapPrompt(message.body) ? "" : message.body,
    attribution: message.createdBy !== "agent" ? null : message.creationSource === "server" ? "t3code" : "agent",
    scheduledTaskId: undefined,
  };
}

export const isSteerIntent = (intent: string | undefined) => intent === "steer" || intent === "promoted_queued_to_steer";

export interface UserMessageGrouping { groupedWithPrevious: boolean; groupedWithNext: boolean; continuesSteer: boolean }

/** resolveUserMessageGrouping: a message groups with the neighbour that is also the reader's own message. */
export function resolveUserMessageGrouping(message: PresentationInput | undefined, previous: PresentationInput | undefined, next: PresentationInput | undefined): UserMessageGrouping {
  const isOwnMessage = (value: PresentationInput | undefined) => value?.role === "user" && resolveUserMessagePresentation(value).attribution === null;
  const groupedWithPrevious = isOwnMessage(message) && isOwnMessage(previous);
  return {
    groupedWithPrevious,
    groupedWithNext: isOwnMessage(message) && isOwnMessage(next),
    continuesSteer: groupedWithPrevious && isSteerIntent(message?.inputIntent) && isSteerIntent(previous?.inputIntent),
  };
}

/** The first non-blank line, which a folded agent or automation message shows as its summary. */
export const foldSummaryOf = (text: string) => text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";

/** The model-switch divider's label ("from → to"): only what changed. The effort is read from the selection's options. */
export function modelSwitchLabel(
  modelSwitch: { from: unknown; to: unknown },
  modelName: (selection: { instanceId: string; model: string }) => string,
): string | null {
  const read = (value: unknown) => {
    if (typeof value !== "object" || value === null) return null;
    const { instanceId, model, options } = value as { instanceId?: unknown; model?: unknown; options?: unknown };
    if (typeof instanceId !== "string" || typeof model !== "string") return null;
    return { instanceId, model, effort: effortOf(options) };
  };
  const from = read(modelSwitch.from);
  const to = read(modelSwitch.to);
  if (!from || !to) return null;
  const modelChanged = from.model !== to.model;
  const effortChanged = from.effort !== undefined && to.effort !== undefined && from.effort !== to.effort;
  if (!modelChanged && !effortChanged) return null;
  const describe = (side: NonNullable<typeof from>) => [modelChanged ? modelName(side) : null, effortChanged ? side.effort : null].filter(Boolean).join(" ");
  return `${describe(from)} → ${describe(to)}`;
}

const REASONING_IDS = ["reasoningEffort", "effort", "reasoning", "variant", "reasoning_effort", "thinking_level", "thinking"];

/** A selection's reasoning effort, from its options (an `{ id, value }` list, or the legacy object form). */
function effortOf(options: unknown): string | undefined {
  if (Array.isArray(options)) {
    for (const id of REASONING_IDS) {
      for (const option of options) {
        if (typeof option === "object" && option !== null && (option as { id?: unknown }).id === id && typeof (option as { value?: unknown }).value === "string") return (option as { value: string }).value;
      }
    }
    return undefined;
  }
  if (typeof options === "object" && options !== null) {
    for (const id of REASONING_IDS) { const value = (options as Record<string, unknown>)[id]; if (typeof value === "string") return value; }
  }
  return undefined;
}
