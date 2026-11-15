import { mount, View } from "nsh";
import { QueuedRunsControl } from "./QueuedRunsControl";
import type { QueuedMessage } from "./runState";

const items: QueuedMessage[] = [
  { runId: "r1", messageId: "m1", text: "Check the build", freshContext: false, attachments: [], source: { createdBy: "agent", creationSource: "server" } },
  { runId: "r2", messageId: "m2", text: "Summarise line one\nmore detail", freshContext: false, attachments: [], source: { createdBy: "agent", senderThreadId: "other" } },
  { runId: "r3", messageId: "m3", text: "see [notes.txt](t3-context://v1/file/file_a1) please", freshContext: false, attachments: [] },
];

mount(() => (
  <View class="w-[600px]">
    <QueuedRunsControl items={() => items} canSendRun={() => true} editingRunId={() => null} busyRunId={() => null} onSendNow={() => {}} onEdit={() => {}} onCancelEdit={() => {}} onRemove={() => {}} />
  </View>
));
