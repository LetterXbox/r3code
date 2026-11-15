// Input waiting for a terminal that is still attaching: a project script's command
// is typed once its session is running (useChatTerminalActions writes after open).
const pending = new Map<string, string>();
const keyOf = (threadId: string, terminalId: string) => `${threadId}\n${terminalId}`;

export function queueTerminalInput(threadId: string, terminalId: string, text: string) {
  pending.set(keyOf(threadId, terminalId), (pending.get(keyOf(threadId, terminalId)) ?? "") + text);
}

/** Takes what is queued for the terminal, leaving nothing behind. */
export function takeTerminalInput(threadId: string, terminalId: string): string {
  const key = keyOf(threadId, terminalId);
  const text = pending.get(key) ?? "";
  pending.delete(key);
  return text;
}

/** useChatTerminalActions.runProjectScript's launch options for a terminal it opens: the script's stopOnSettle and extra env. */
export interface TerminalLaunchOptions { stopOnSettle?: boolean; env?: Record<string, string> }
const launches = new Map<string, TerminalLaunchOptions>();

export function queueTerminalLaunch(threadId: string, terminalId: string, options: TerminalLaunchOptions) {
  launches.set(keyOf(threadId, terminalId), options);
}

/** Takes the launch options waiting for the terminal's first attach. */
export function takeTerminalLaunch(threadId: string, terminalId: string): TerminalLaunchOptions {
  const key = keyOf(threadId, terminalId);
  const options = launches.get(key) ?? {};
  launches.delete(key);
  return options;
}
