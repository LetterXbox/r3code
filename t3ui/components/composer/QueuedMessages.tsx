// The queued messages at the end of the transcript (the list footer in the web's ChatView): dashed bubbles
// with Send now, edit and remove, wired to the thread's real queue commands.
import { View } from "nsh";
import { ComposerLane } from "../thread/ComposerLane";
import { QueuedRunsControl, queuedRunEditBlockedReason } from "./QueuedRunsControl";
import { pendingQueuedSendsFor, threadUserInputs } from "../../store";
import { useThreadScope } from "../sideChat/threadScope";
import { readThreadAttachment } from "../thread/readAttachment";
import {
  busyQueuedRunId, cancelQueuedEdit, canSendQueuedRun, editingQueuedRun, queuedSendNowTooltip, removeQueued, sendQueuedNow, startQueuedEdit, queueDeps, threadQueueFor,
} from "./queueState";

export function QueuedMessages(props: { area: () => number }) {
  const scope = useThreadScope();
  const scopedQueue = scope.scoped ? threadQueueFor(() => scope.thread()?.id ?? "") : null;
  const queue = () => scopedQueue ? scopedQueue.queue() : queueDeps.queue();
  const threadId = () => scope.scoped ? scope.thread()?.id ?? "" : queueDeps.threadId() ?? "";
  const content = () => (
    <QueuedRunsControl
      items={() => queue().queued}
      pending={() => pendingQueuedSendsFor(threadId())}
      loadAttachment={(id, options) => readThreadAttachment(threadId(), id, options)}
      canSendRun={(item) => scope.run(() => canSendQueuedRun(item))}
      sendNowTooltip={(index) => scope.run(() => queuedSendNowTooltip(index))}
      editBlockedReason={() => queuedRunEditBlockedReason({ openQuestionCount: scope.scoped ? scope.userInputs().length : threadUserInputs().length })}
      editingRunId={() => scope.run(() => editingQueuedRun()?.runId ?? null)}
      busyRunId={busyQueuedRunId}
      onSendNow={(item) => scope.run(() => { void sendQueuedNow(item); })}
      onEdit={(item) => scope.run(() => startQueuedEdit(item))}
      onCancelEdit={() => scope.run(() => cancelQueuedEdit())}
      onRemove={(item) => scope.run(() => { void removeQueued(item); })}
    />
  );
  return (
    <>
      {queue().queued.length > 0 || pendingQueuedSendsFor(threadId()).length > 0 ? (scope.scoped
        ? <View class="px-3">{content()}</View>
        : <ComposerLane area={props.area}>{content()}</ComposerLane>) : null}
    </>
  );
}
