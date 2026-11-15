// useThreadTerminalActions: canWrite (terminal:operate) gates launching a terminal, and allocateTerminalId avoids the
// server's known sessions; without terminal:read the server's list is unseen, so ids get a random suffix.
import { hasSessionScope, sessionScopeState, TERMINAL_OPERATE_SCOPE, TERMINAL_READ_SCOPE } from "../../backend/sessionScopes";
import { serverTerminalIds, serverTerminalSessionsKnown } from "../sidebar/terminalStatus";
import type { TerminalAllocation } from "./terminalLogic";

/** Whether this client may start a terminal. An old server that has not answered yet is not blocked (the session read
 * is pending); a session that answered without terminal:operate is. */
export function canLaunchTerminal(): boolean {
  return sessionScopeState(TERMINAL_OPERATE_SCOPE) !== "denied";
}

export function allocationFor(threadId: string, randomId: () => string = () => crypto.randomUUID(), known: () => boolean = () => serverTerminalSessionsKnown(threadId)): TerminalAllocation {
  // canReuse: the server's list has arrived for this connection (a new server session's list lags) and is readable.
  const canReuse = known() && hasSessionScope(TERMINAL_READ_SCOPE);
  return { used: serverTerminalIds(threadId), ...(canReuse ? {} : { suffix: randomId() }) };
}

// The drawer key -> thread id of mounted drawers, so commands (terminal.new / split) allocate for the right thread.
const drawerThreads = new Map<string, string>();
export function registerDrawerThread(stateKey: string, threadId: string) { drawerThreads.set(stateKey, threadId); }
export function drawerAllocation(stateKey: string): TerminalAllocation {
  const threadId = drawerThreads.get(stateKey);
  return threadId ? allocationFor(threadId) : {};
}
