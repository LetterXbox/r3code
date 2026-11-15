// The thread details card's "Manage scheduled tasks" and "Edit automation" open Settings -> Scheduled tasks
// (`/settings/scheduled-tasks`, with `taskId` to open that task's editor). Settings has no router here, so the
// request is a signal the Scheduled tasks panel reads once its list has loaded.
import { signal } from "nsh";
import { openSettings } from "../../store";

export const requestedScheduledTaskId = signal<string | null>(null);

/** Opens the Scheduled tasks settings, and the editor of `taskId` when given. */
export function openScheduledTasks(taskId: string | null = null, open: (path: string) => void = openSettings) {
  requestedScheduledTaskId.set(taskId);
  open("/settings/scheduled-tasks");
}
