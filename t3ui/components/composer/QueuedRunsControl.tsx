// The queue above the composer (chat/QueuedRunsControl.tsx): each queued message as a dashed,
// unfilled bubble on the right with "Send now", edit and remove actions beneath it; a longer queue
// shows its first rows and a "Show all N queued" toggle.
import { signal, Text, View } from "nsh";
import { ComposerIcon } from "./ComposerIcon";
import type { QueuedMessage } from "./runState";
import { ChevronTurn } from "../motion/Motion";
import { resolveUserMessagePresentation } from "../thread/timeline/userMessagePresentation";
import { scheduledTaskTitle } from "../thread/scheduledTaskTitle";
import { threadById, type PendingQueuedSend } from "../../store";
import { Thumbnail } from "../thread/MessageMedia";
import { readAttachment } from "../thread/readAttachment";
import { tokenAlpha, tokenOver } from "./tokenColor";

/** A longer queue shows its first messages and a button that shows the rest. */
export const QUEUE_VISIBLE_ROWS = 3;

const CONTEXT_REFERENCE = /!?\[((?:\\.|[^\]\\]){0,200})\]\(t3-context:\/\/v1\/([a-z-]+)\/[A-Za-z0-9_-]{1,128}\)/g;
/** The queued row's text: context references as their labels (image chips dropped when thumbnails show). */
export function queuedPreviewText(text: string, hasThumbnails: boolean): string {
  return text.replace(CONTEXT_REFERENCE, (_whole, label: string, kind: string) => (kind === "image" && hasThumbnails ? "" : label.replace(/\\(.)/g, "$1"))).trim();
}

/** client-runtime queuedRunEdit.ts queuedRunEditBlockedReason. */
export const queuedRunEditBlockedReason = (input: { openQuestionCount: number }) => (input.openQuestionCount > 0 ? "Answer the question to edit queued messages" : null);

export function visibleQueue<T>(items: readonly T[], showAll: boolean): T[] {
  return items.length > QUEUE_VISIBLE_ROWS && !showAll ? items.slice(0, QUEUE_VISIBLE_ROWS - 1) : [...items];
}

function ActionButton(props: { label: string; icon?: string; text?: string; tooltip?: string; disabled?: boolean; onPress: () => void }) {
  return (
    <View
      class={`h-6 flex-row items-center justify-center gap-1 rounded-md px-1.5 hover:bg-accent ${props.disabled ? "opacity-64" : ""}`}
      disabled={props.disabled}
      onPress={props.onPress}
      accessibilityLabel={props.label}
      tooltip={props.tooltip}
      role="button"
    >
      {props.icon ? <ComposerIcon name={props.icon} size={14} tint={tokenOver("foreground", "background", 0.75)} /> : null}
      {props.text ? <Text class="text-xs" style={{ color: tokenOver("foreground", "background", 0.75) }}>{props.text}</Text> : null}
    </View>
  );
}

export function QueuedRunsControl(props: {
  items: () => QueuedMessage[];
  /** Messages sent behind a running turn that the server has not queued yet: shown as "Saving" (optimistic rows). */
  pending?: () => PendingQueuedSend[];
  loadAttachment?: typeof readAttachment;
  /** "Send now" shows when the queue can start a turn or steer into the running one. */
  canSendRun: (item: QueuedMessage) => boolean;
  /** queuedRunEditBlockedReason: why editing queued messages is blocked (an open question), or null. */
  editBlockedReason?: () => string | null;
  /** The Send now tooltip for the row at this position (queuedSendNowTooltip). */
  sendNowTooltip?: (index: number) => string;
  editingRunId: () => string | null;
  busyRunId: () => string | null;
  onSendNow: (item: QueuedMessage) => void;
  onEdit: (item: QueuedMessage) => void;
  onCancelEdit: () => void;
  onRemove: (item: QueuedMessage) => void;
}) {
  const showAll = signal(false);
  const items = () => props.items();
  const pending = () => props.pending?.() ?? [];
  const total = () => items().length + pending().length;
  const visibleCount = () => total() > QUEUE_VISIBLE_ROWS && !showAll() ? QUEUE_VISIBLE_ROWS - 1 : total();
  const visible = () => items().slice(0, visibleCount());
  const visiblePending = () => pending().slice(0, Math.max(0, visibleCount() - items().length));
  return (
    <View class="mx-auto w-full gap-2 pb-4" accessibilityLabel={`${total()} queued message${total() === 1 ? "" : "s"}`}>
      <View class="items-end gap-3">
        <Each of={visible()} key={(item) => item.runId}>
          {(item, position) => {
            const isEditing = () => item().runId === props.editingRunId();
            // QueuedRunsControl QueuedMessage: a queued turn wears its sent form's attribution; context chips read as their
            // labels, image chips go when thumbnails show, and an attachment-only bootstrap prompt shows no text.
            const presentation = () => resolveUserMessagePresentation({ role: "user", body: item().text, id: item().messageId, ...(item().source ?? {}) });
            const thumbnails = () => item().attachments.filter((attachment) => attachment.type === "image");
            const previewText = () => queuedPreviewText(presentation().text, thumbnails().length > 0);
            const expanded = signal(false);
            const fold = () => (presentation().attribution === "automation"
              ? { label: "Automation", summary: (presentation().scheduledTaskId ? scheduledTaskTitle(presentation().scheduledTaskId) : undefined) ?? previewText().split(/\r?\n/, 1)[0] ?? "" }
              : presentation().attribution === "agent"
                ? { label: (item().source?.senderThreadId ? threadById(item().source!.senderThreadId!)?.title.trim() : undefined) || "Agent", summary: previewText().split(/\r?\n/).find((line) => line.trim()) ?? "" }
                : null);
            const busy = () => props.busyRunId() !== null;
            return (
              <View class="w-full items-end gap-1" accessibilityLabel={`Queued message ${position() + 1} of ${items().length}, not sent`}>
                {presentation().attribution === "t3code" ? <Text class="me-1 text-2xs text-muted-foreground-70">Sent by T3 Code</Text> : null}
                {presentation().guestName ? <Text class="me-1 text-2xs text-muted-foreground">{presentation().guestName}</Text> : null}
                <View class={`max-w-[80%] rounded-2xl border border-dashed ${fold() && expanded() ? "w-full" : ""} ${fold() ? "" : "px-3 py-2"}`} style={{ borderColor: isEditing() ? tokenAlpha("primary", 0.6) : presentation().attribution === "guest" ? tokenAlpha("guest", 0.5) : tokenAlpha("muted-foreground", 0.4) }}>
                  {fold() ? (
                    <View class="flex-row items-center gap-1.5 px-3 py-2" role="button" accessibilityLabel={`${fold()!.label}: ${fold()!.summary}`} accessibilityState={{ expanded: expanded() }} onPress={() => expanded.update((value) => !value)}>
                      <Text class="max-w-[50%] shrink-0 truncate text-sm text-muted-foreground">{fold()!.label}</Text>
                      <Text class="min-w-0 flex-1 truncate text-sm text-muted-foreground">{fold()!.summary}</Text>
                      <ComposerIcon name={expanded() ? "chevron-up" : "chevron-down"} size={14} />
                    </View>
                  ) : null}
                  {!fold() || expanded() ? (
                    <View class={`gap-2 ${fold() ? "px-3 pb-2" : ""}`}>
                      {thumbnails().length > 0 ? (
                        <View class="flex-row flex-wrap items-center gap-1">
                          <Each of={thumbnails()} key={(attachment) => attachment.id}>
                            {(attachment) => <Thumbnail attachment={{ ...attachment(), type: "image" } as never} load={props.loadAttachment ?? readAttachment} class="size-8 rounded-md border border-border-70" onOpen={() => {}} />}
                          </Each>
                        </View>
                      ) : null}
                      {previewText() ? <Text class={`text-sm ${isEditing() ? "text-foreground" : "text-muted-foreground"}`}>{previewText()}</Text> : null}
                    </View>
                  ) : null}
                </View>
                <View class="flex-row items-center gap-0.5 pe-1">
                  {props.canSendRun(item()) && !isEditing() ? (
                    <ActionButton label="Send now" icon="arrow-up" text="Send now" tooltip={props.sendNowTooltip?.(position())} disabled={busy()} onPress={() => props.onSendNow(item())} />
                  ) : null}
                  {isEditing() ? (
                    <>
                      <Text class="px-1 text-xs text-foreground">Editing in the composer</Text>
                      <ActionButton label="Cancel editing queued message" text="Cancel" onPress={props.onCancelEdit} />
                    </>
                  ) : (
                    <>
                      {/* queuedRunEditBlockedReason: an open question blocks edits; a guest's message can be removed, not rewritten. */}
                      <ActionButton label="Edit queued message" icon="pencil" tooltip={props.editBlockedReason?.() ?? "Edit in the composer"} disabled={busy() || props.editBlockedReason?.() != null || presentation().attribution === "guest"} onPress={() => props.onEdit(item())} />
                      <ActionButton label="Remove queued message" icon="x" disabled={busy()} onPress={() => props.onRemove(item())} />
                    </>
                  )}
                </View>
              </View>
            );
          }}
        </Each>
        <Each of={visiblePending()} key={(item) => item.id}>
          {(item) => {
            const thumbnails = () => item().attachments.filter((attachment) => attachment.type === "image");
            const previewText = () => queuedPreviewText(item().text, thumbnails().length > 0);
            return (
              <View class="w-full items-end gap-1" accessibilityLabel="Queued message, saving">
                <View class="max-w-[80%] gap-2 rounded-2xl border border-dashed px-3 py-2" style={{ borderColor: tokenAlpha("muted-foreground", 0.4) }}>
                  {thumbnails().length > 0 ? (
                    <View class="flex-row flex-wrap items-center gap-1">
                      <Each of={thumbnails()} key={(attachment) => attachment.id}>
                        {(attachment) => <Thumbnail attachment={{ ...attachment(), type: "image" } as never} load={props.loadAttachment ?? readAttachment} class="size-8 rounded-md border border-border-70" onOpen={() => {}} />}
                      </Each>
                    </View>
                  ) : null}
                  {previewText() ? <Text class="text-sm text-muted-foreground">{previewText()}</Text> : null}
                </View>
                <View class="flex-row items-center gap-1 px-1 pe-2" accessibilityLabel="Saving">
                  <ComposerIcon name="clock-3" size={12} />
                  <Text class="text-xs text-muted-foreground">Saving</Text>
                </View>
              </View>
            );
          }}
        </Each>
      </View>
      {total() > QUEUE_VISIBLE_ROWS ? (
        <View class="flex-row items-center gap-1 self-end pe-1" onPress={() => showAll.set(!showAll())} accessibilityLabel={showAll() ? "Show fewer" : `Show all ${total()} queued`} role="button">
          <Text class="text-xs text-muted-foreground">{showAll() ? "Show fewer" : `Show all ${total()} queued`}</Text>
          <ChevronTurn open={showAll} degrees={180} stillWithReducedMotion><ComposerIcon name="chevron-down" size={14} /></ChevronTurn>
        </View>
      ) : null}
    </View>
  );
}
