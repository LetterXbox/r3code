// readEnvironmentScope / useEnvironmentScope for the primary environment: the scopes its session grants this client
// (`GET /api/auth/session`), read once per connection. "unknown" until the session answers (the reference's scope reads
// false until then). previewScope.ts keeps its own copy for preview:operate.
import { effect, signal, untracked } from "nsh";
import { fetchSessionGrant, parseSessionGrant, sessionGrantsScope, type SessionGrantShape } from "./providers";
import { backendBearer, backendConnectionGeneration, backendStatus, backendUrl } from "../store";

export type ScopeState = "unknown" | "granted" | "denied";

const grant = signal<SessionGrantShape | null | undefined>(undefined);
const overrides = signal<Record<string, ScopeState>>({});
let started = false;

/** Tests set a scope's answer without a session. */
export function overrideSessionScope(scope: string, state: ScopeState | null) {
  overrides.update((all) => {
    const next = { ...all };
    if (state === null) delete next[scope]; else next[scope] = state;
    return next;
  });
}

export function sessionScopeState(scope: string): ScopeState {
  const forced = overrides()[scope];
  if (forced) return forced;
  const current = grant();
  if (current === undefined) return "unknown";
  return current !== null && sessionGrantsScope(current, scope) ? "granted" : "denied";
}

export const hasSessionScope = (scope: string) => sessionScopeState(scope) === "granted";

export function startSessionScopes() {
  if (started) return;
  started = true;
  effect(() => {
    const connected = backendStatus() === "connected";
    void backendConnectionGeneration();
    const url = backendUrl();
    const bearer = backendBearer();
    if (!connected || !bearer) return;
    let stale = false;
    untracked(() => {
      void fetchSessionGrant(url, bearer).then((value) => {
        if (!stale) grant.set(value === null ? null : parseSessionGrant(value));
      }).catch(() => { if (!stale) grant.set(undefined); });
    });
    return () => { stale = true; };
  });
}

export const TERMINAL_READ_SCOPE = "terminal:read";
export const TERMINAL_OPERATE_SCOPE = "terminal:operate";
export const FILESYSTEM_READ_SCOPE = "filesystem:read";

/** useEnvironmentScope, read the way this client's controls use it: refused only once the session says no (unknown stays open,
 * since the port's controls are not re-checked when the session answers). */
export const scopeAllows = (scope: string) => sessionScopeState(scope) !== "denied";
export const ORCHESTRATION_OPERATE_SCOPE = "orchestration:operate";
export const FILESYSTEM_WRITE_SCOPE = "filesystem:write";
export const SETTINGS_WRITE_SCOPE = "settings:write";
export const ACCESS_WRITE_SCOPE = "access:write";
