// What a drop does: the verb resolved in sidebarDrop.ts, run with the actions the thread menu uses.
import { setThreadPinned } from "../../store";
import type { Thread } from "../../store";
import type { DropVerb } from "./sidebarDrop";
import { settleThread, threadActionNotice, threadUndo, unpinThreadWithUndo, unsettleThread, unsnoozeThread } from "./threadActions";

const failure = (title: string) => (error: unknown) => threadActionNotice.failure(title, error);

export async function runDropVerb(thread: Thread, verb: DropVerb): Promise<void> {
  switch (verb) {
    case "pin":
      setThreadPinned(thread.id, true);
      return;
    case "unpin":
      await unpinThreadWithUndo(thread);
      return;
    case "settle":
      await settleThread(thread.id)
        .then(() => threadUndo.show("Settled", () => unsettleThread(thread.id), thread.id))
        .catch(failure("Failed to settle thread"));
      return;
    case "unsettle":
      await unsettleThread(thread.id).catch(failure("Failed to un-settle thread"));
      return;
    case "wake":
      await unsnoozeThread(thread.id).catch(failure("Failed to wake thread"));
      return;
  }
}
