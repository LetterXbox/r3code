import { mount, signal, View } from "nsh";
import { QueuedRunsControl } from "./QueuedRunsControl";
import type { QueuedMessage } from "./runState";

const items = signal<QueuedMessage[]>(
  ["first", "second", "third", "fourth"].map((text, index) => ({ runId: `r${index}`, messageId: `m${index}`, text, freshContext: false, attachments: [] })),
);
const editing = signal<string | null>(null);

function Fixture() {
  return (
    <View class="w-[600px]">
      <QueuedRunsControl
        items={items}
        pending={() => [{ id: "pending-1", text: "saving soon", attachments: [] }]}
        canSendRun={() => true}
        editingRunId={editing}
        busyRunId={() => null}
        onSendNow={(item) => items.set(items().filter((entry) => entry.runId !== item.runId))}
        onEdit={(item) => editing.set(item.runId)}
        onCancelEdit={() => editing.set(null)}
        onRemove={(item) => items.set(items().filter((entry) => entry.runId !== item.runId))}
      />
    </View>
  );
}
mount(Fixture);
