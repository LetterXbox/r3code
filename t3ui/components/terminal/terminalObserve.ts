// terminalSessions.ts attachedTerminalSessionFamily: canOperate ? terminal.attach : canRead ? terminal.observe. A session
// granted terminal:read but denied terminal:operate follows a terminal read-only (`terminal.observe`, the same event
// stream as attach, keyed by thread and terminal only); it never opens, resizes or writes one.
import type { ScopeState } from "../../backend/sessionScopes";

export function terminalStreamMethod(operate: ScopeState, read: ScopeState): "terminal.attach" | "terminal.observe" {
  return operate === "denied" && read === "granted" ? "terminal.observe" : "terminal.attach";
}
