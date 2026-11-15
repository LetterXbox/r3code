// useScheduledTaskTitle (TimelineUserMessageRow.tsx): an automation message's fold summary is its scheduled task's title,
// read from the live scheduledTasks.subscribe stream; the stream opens the first time a row asks and stays open.
import { signal } from "nsh";
import { readScheduledTasks } from "../scheduled/data";
import { subscribeBackend } from "../../store";

const titles = signal<Record<string, string>>({});
let started = false;

type Subscribe = (method: string, payload: unknown, receive: (value: unknown) => void, fail: (error: Error) => void) => () => void;

export function scheduledTaskTitle(taskId: string | undefined, subscribe: Subscribe = subscribeBackend as unknown as Subscribe): string | undefined {
  if (!taskId) return undefined;
  if (!started) {
    started = true;
    subscribe("scheduledTasks.subscribe", {}, (value) => {
      try { titles.set(Object.fromEntries(readScheduledTasks(value).map((task) => [task.id, task.title]))); } catch { /* keep the last titles */ }
    }, () => { started = false; });
  }
  const title = titles()[taskId]?.trim();
  return title ? title : undefined;
}

/** Test seam. */
export function resetScheduledTaskTitlesForTests() { titles.set({}); started = false; }
