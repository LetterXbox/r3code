// useEnvironmentScope(<scope>) for the connected environment: whether this session holds a permission such as
// settings:write (AuthSettingsWriteScope) or orchestration:operate. The web reads it from the session grant; so does
// this, once per connection URL. Until the grant is read (or when there is no bearer to read it with) the access is
// "unknown", which pages treat as allowed: the server still refuses what the session cannot do.
import { signal } from "nsh";
import { fetchSessionGrant, sessionGrantsScope, type SessionGrantShape } from "../../backend/providers";
import { backendBearer, backendUrl } from "../../store";

export type SettingsWriteAccess = "granted" | "denied" | "unknown";

const grant = signal<SessionGrantShape | null>(null);
let checkedFor = "";
const overrideSignal = signal<SettingsWriteAccess | null>(null);

/** Tests pin the access of every scope without an HTTP session behind it; null restores the real read. */
export function setSettingsWriteAccessForTest(value: SettingsWriteAccess | null) {
  overrideSignal.set(value);
  checkedFor = "";
}

/** The access to one permission, starting the grant read for the current connection the first time it is asked. */
export function sessionScopeAccess(scope: string): SettingsWriteAccess {
  const pinned = overrideSignal();
  if (pinned !== null) return pinned;
  const url = backendUrl();
  const bearer = backendBearer();
  if (url && bearer && checkedFor !== url) {
    checkedFor = url;
    grant.set(null);
    void fetchSessionGrant(url, bearer)
      .then((next) => { if (checkedFor === url) grant.set(next); })
      .catch(() => { if (checkedFor === url) checkedFor = ""; });
  }
  const current = grant();
  return current === null ? "unknown" : sessionGrantsScope(current, scope) ? "granted" : "denied";
}

export const settingsWriteAccess = () => sessionScopeAccess("settings:write");
export const settingsWriteDenied = () => settingsWriteAccess() === "denied";
/** AuthOrchestrationOperateScope: renaming, pinning and removing projects. */
export const orchestrationOperateDenied = () => sessionScopeAccess("orchestration:operate") === "denied";
