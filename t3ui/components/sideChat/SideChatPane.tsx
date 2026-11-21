// SideChatPane.tsx: a side chat tab in the right panel. Its header (title, Bring back, Delete, Close) over the side
// chat's own chat: its transcript, request panels and a composer, all bound to the child thread (ThreadScope),
// beside the parent thread. The pane holds the child's thread subscription while it is mounted.
import { ORCHESTRATION_OPERATE_SCOPE, scopeAllows } from "../../backend/sessionScopes";
import { cleanup, computed, signal, Text, View } from "nsh";
import { Tooltip } from "nsh/base";
import {
  allThreads,
  backendConnectionGeneration,
  backendStatus,
  backendUrl,
  openThread,
  pendingQueuedSendsFor,
  requestBackend,
  respondToApproval,
  respondToUserInput,
  retainThread,
  threadRunsFor,
  releaseThreadDraft,
  shellSnapshotLoaded,
} from "../../store";
import { Composer } from "../Composer";
import { attachExtraContext, threadContextRecord } from "../composer/contextChips";
import { serverEnvironment } from "../../pages/settings/settingsState";
import { serverEnvironmentIdOf } from "../../environments/machineMentions";
import { AttachmentPreview, type MessageAttachment } from "../thread/AttachmentPreview";
import { readThreadAttachment } from "../thread/readAttachment";
import { openAttachmentAction } from "../rightPanel/panelState";
import { QueuedMessages } from "../composer/QueuedMessages";
import { threadQueueFor } from "../composer/queueState";
import { HIcon } from "../header/HeaderIcons";
import { deleteThread } from "../sidebar/threadActions";
import { ApprovalPanel } from "../thread/ApprovalPanel";
import { UserInputPanel } from "../thread/UserInputPanel";
import { dismissUserInput } from "../thread/userInputDismiss";
import { mergeTimeline } from "../thread/timeline";
import { showToast } from "../toast/toastState";
import { ThreadTimeline } from "../../pages/ThreadView";
import { composerOwner, focusMainComposer } from "./sideChatFocus";
import { BRING_BACK_TOOLTIP, bringBackBlockedReason, latestMergeBackRun, mergeBackCommand } from "./sideChatLogic";
import { ThreadScope, threadScopeFor } from "./threadScope";
import { releasePromptKeyboard, settledLayout } from "../composer/editor/PromptEditor";

export function SideChatPane(props: { threadId: string; onClose?: () => void }) {
  const threadId = props.threadId;
  cleanup(retainThread(threadId));
  // Closing the pane hands the keyboard back to the parent composer.
  cleanup(() => { if (composerOwner() === threadId) focusMainComposer(); });
  const scope = threadScopeFor(threadId);
  const child = () => allThreads().find((thread) => thread.id === threadId);
  // The thread object changes on every server update; a boolean branch keeps the side composer mounted (PromptEditor settledLayout).
  const hasChild = settledLayout(() => child() !== undefined);
  const parentId = openThread()?.id ?? null;
  const parent = () => allThreads().find((thread) => thread.id === parentId);
  const deleting = signal(false);
  const bringingBack = signal(false);
  const failure = signal("");
  const preview = signal<MessageAttachment | null>(null);
  const mergeRun = computed(() => latestMergeBackRun(scope.runs()));
  const canAddToChat = () => child() !== undefined && (child()!.lastMessageAt !== null || scope.messages().some((message) => message.role === "user"));
  function addToChat() {
    if (!canAddToChat() || parentId === null) return;
    const environmentId = serverEnvironmentIdOf(child()?.environmentId ?? parent()?.environmentId ?? "primary", { environment: serverEnvironment() }) ?? "primary";
    attachExtraContext(parentId, threadContextRecord({ environmentId, threadId }, child()?.title?.trim() || "Side chat"));
  }
  async function remove() {
    const target = child();
    if (!target || deleting()) return;
    deleting.set(true);
    failure.set("");
    try {
      await deleteThread(target.id);
      releaseThreadDraft(target.id);
      props.onClose?.();
    } catch (error) {
      // SideChatPane.tsx: a failed delete is an error toast, the reason as its description.
      showToast({ type: "error", title: "Could not delete the side chat", ...(error instanceof Error && error.message ? { description: error.message } : {}) });
    }
    deleting.set(false);
  }
  const iconButton = (label: string, icon: string, disabled: boolean, onPress: () => void) => (
    <View role="button" accessibilityLabel={label} disabled={disabled} tooltip={<SideChatTip text={label} />} onPress={onPress} class={`size-7 items-center justify-center rounded-md ${disabled ? "opacity-64" : "hover:bg-accent"}`}>
      <HIcon name={icon} size={14} />
    </View>
  );
  const expandedActivity = signal<Record<string, boolean>>({});
  const timeline = computed(() => mergeTimeline(scope.messages(), scope.activity(), threadRunsFor(threadId)));
  const queue = threadQueueFor(() => threadId);
  const requestScope = () => JSON.stringify([backendUrl(), threadId]);
  return (
    <View class="min-h-0 w-full min-w-0 flex-1" accessibilityLabel="Side chat">
      <View class="h-9 shrink-0 flex-row items-center gap-1 border-b border-border pl-3 pr-1">
        <Text class="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{child()?.title ?? "Side chat"}</Text>
        <View
          role="button"
          accessibilityLabel="Add to chat"
          accessibilityState={{ disabled: !canAddToChat() }}
          tooltip={<SideChatTip text={canAddToChat() ? "Adds this side chat to the main thread's next message." : "Available after the first message."} />}
          onPress={addToChat}
          class={`h-7 items-center justify-center rounded-md px-2 ${!canAddToChat() ? "opacity-64" : "hover:bg-accent"}`}
        >
          <Text class="text-xs text-foreground">Add to chat</Text>
        </View>
        {iconButton("Delete side chat", "trash-2", child() === undefined || deleting(), () => void remove())}
        {iconButton("Close side chat", "x", false, () => { void releasePromptKeyboard().then(() => props.onClose?.()); })}
      </View>
      {failure() ? <Text class="px-3 py-1 text-xs text-destructive" role="alert">{failure()}</Text> : null}
      {hasChild() ? (
        <ThreadScope.Provider value={scope}>
          <View class="min-h-0 flex-1" accessibilityLabel="Side chat thread">
            <View class="relative min-h-0 flex-1">
              <ThreadTimeline
                entries={timeline}
                scope={() => ({ environment: backendUrl(), generation: backendConnectionGeneration(), threadId })}
                expandedActivity={expandedActivity}
                onToggleActivity={(id) => expandedActivity.update((current) => ({ ...current, [id]: !current[id] }))}
                onOpenAttachment={(attachment) => attachment.type === "image" ? preview.set(attachment) : openAttachmentAction({ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, threadId })}
                footer={() => <QueuedMessages area={() => 0} />}
              />
              {timeline().length === 0 && queue.queue().queued.length === 0 && pendingQueuedSendsFor(threadId).length === 0 ? (
                <View class="absolute inset-0 items-center justify-center bg-background px-6">
                  <Text class="text-center text-sm text-muted-foreground">Send a message to start the conversation.</Text>
                </View>
              ) : null}
            </View>
            {scope.approvals().length > 0 ? (
              <ApprovalPanel scope={requestScope} approvals={scope.approvals} onRespond={(id, decision) => scope.run(() => respondToApproval(id, decision))} />
            ) : null}
            {scope.userInputs().length > 0 ? (
              <UserInputPanel scope={requestScope} requests={scope.userInputs} onRespond={(id, answers) => scope.run(() => respondToUserInput(id, answers))} onDismiss={(id) => scope.run(() => dismissUserInput(id))} />
            ) : null}
            <View class="px-3">
              <Composer />
            </View>
          </View>
        </ThreadScope.Provider>
      ) : shellSnapshotLoaded() ? <Text class="p-3 text-xs text-muted-foreground">This side chat was deleted.</Text> : null}
      <If when={preview()}>{(attachment) => <AttachmentPreview attachment={attachment} load={(id, options) => readThreadAttachment(threadId, id, options)} onClose={() => preview.set(null)} />}</If>
    </View>
  );
}

function SideChatTip(props: { text: string }) {
  return <Tooltip class="max-w-80 rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">{props.text}</Text></Tooltip>;
}
