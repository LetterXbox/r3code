// Thread navigation from packages/shared/src/keybindings.ts DEFAULT_KEYBINDINGS:
//   mod+shift+[  thread.previous      mod+shift+]  thread.next
//   mod+1..mod+9 thread.jump.1..9 (THREAD_JUMP_KEYBINDING_COMMANDS)
//   mod+shift+p  thread.pin (pins or unpins the open thread)
import { registerCommands } from "../../commands/registry";
import { openThread, openThreadById, setThreadPinned } from "../../store";
import { adjacentThreadId } from "./threadStatus";
import { orderedThreadIds } from "./sidebarModel";

export function stepThread(direction: "previous" | "next") {
  const target = adjacentThreadId(orderedThreadIds(), openThread()?.id ?? null, direction);
  if (target) openThreadById(target);
}

export function jumpToThread(position: number) {
  const target = orderedThreadIds()[position - 1];
  if (target) openThreadById(target);
}

export function togglePinOpenThread() {
  const thread = openThread();
  if (thread) setThreadPinned(thread.id, !thread.pinned);
}

// Bound through the command registry so a saved keybinding override re-binds them.
const commands: Record<string, () => void> = {
  "thread.previous": () => stepThread("previous"),
  "thread.next": () => stepThread("next"),
  "thread.pin": togglePinOpenThread,
};
for (let position = 1; position <= 9; position++) commands[`thread.jump.${position}`] = () => jumpToThread(position);
registerCommands(commands);
