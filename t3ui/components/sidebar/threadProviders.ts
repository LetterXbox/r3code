// resolveThreadProviderStack (client-runtime models.ts): the providers a thread has run on, oldest
// first, at most three, ending with the one it runs on now.
import type { Thread } from "../../store";

const STACK_LIMIT = 3;

export function threadProviderStack(thread: Thread): string[] {
  const current = thread.meta?.providerInstanceId;
  if (!current) return [];
  const previous = (thread.meta?.providerInstanceHistory ?? []).filter((id) => id !== current);
  return [...previous.slice(-(STACK_LIMIT - 1)), current];
}
