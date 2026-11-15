import { mount, signal, Text, View } from "nsh";
import { QueuedMessages } from "./QueuedMessages";
import { queueDeps } from "./queueState";
import type { QueueState } from "./runState";
import { composerDraft, createThread, setComposerDraft } from "../../store";

// A thread with an active run and two queued messages, and recording stand-ins for the queue commands.
const calls = signal<string[]>([]);
const record = (entry: string) => { calls.set([...calls(), entry]); return Promise.resolve(undefined); };
const queued = signal<QueueState["queued"]>([
  { runId: "run:thread:t1:ordinal:7", messageId: "message:7", text: "first queued", freshContext: false, attachments: [] },
  { runId: "run:thread:t1:ordinal:8", messageId: "message:8", text: "second queued", freshContext: false, attachments: [] },
]);
queueDeps.threadId = () => "thread:t1";
queueDeps.queue = () => ({
  activeRun: { id: "run:thread:t1:ordinal:6", status: "running", ordinal: 6, queuePosition: null, queueHeld: false, userMessageId: "message:6", freshContext: false, startedAt: null },
  queued: queued(), isHeld: false, canSendNow: false, canPromoteToSteer: true, promoteSkipsCompaction: false, resumableRunId: null,
});
queueDeps.commands = {
  resume: (threadId, runId) => record(`resume:${threadId}:${runId}`),
  promote: (threadId, queuedRunId, targetRunId) => record(`promote:${threadId}:${queuedRunId}:${targetRunId}`),
  cancel: (threadId, runId) => { queued.set(queued().filter((item) => item.runId !== runId)); return record(`cancel:${threadId}:${runId}`); },
};
createThread(null);
setComposerDraft("my draft");

function Fixture() {
  return (
    <View class="w-[600px]">
      <QueuedMessages area={() => 700} />
      <Text>{`calls:${calls().join(",") || "none"}`}</Text>
      <Text>{`draft:${composerDraft()}`}</Text>
    </View>
  );
}
mount(Fixture);
