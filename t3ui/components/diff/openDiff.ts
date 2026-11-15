// The entry points the chat timeline calls (ChangedFilesTree "Open diff" / a changed file, a file_change tool call's
// "View diff"): the thread's Changes panel opens on that turn (scrolled to the file) or that tool call.
import { openSurfaceAction } from "../rightPanel/panelState";
import { noteExplicitDiffOpen, selectToolCall, selectTurn, type ToolCallDiffTarget } from "./diffPanelStore";

/** selectTurn + open the diff surface: `filePath` reveals that file once the turn's diff is in. */
export function openTurnDiff(threadId: string, runId: string, filePath?: string) {
  selectTurn(threadId, runId, filePath);
  noteExplicitDiffOpen(threadId);
  openSurfaceAction("diff");
}

/** selectToolCall + open the diff surface. `revision` is the item's detail revision ("live" while it works). */
export function openToolCallDiff(threadId: string, target: ToolCallDiffTarget) {
  selectToolCall(threadId, target);
  noteExplicitDiffOpen(threadId);
  openSurfaceAction("diff");
}
