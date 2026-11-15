// What this session may do to source control: `useEnvironmentScope(environmentId, AuthSourceControlWriteScope)` and
// `AuthOrchestrationOperateScope` in GitActionsControl.tsx. The session is the one `GET /api/auth/session` reports;
// until it is known (or when it cannot be read) the card stays usable and the server refuses what is not allowed.
import { signal } from "nsh";
import { fetchSessionGrant, parseSessionGrant, sessionGrantsScope } from "../../backend/providers";
import { backendBearer, backendUrl } from "../../store";

interface Scopes { sourceControlWrite: boolean; orchestrationOperate: boolean; previewOperate: boolean }
const scopes = signal<Scopes>({ sourceControlWrite: true, orchestrationOperate: true, previewOperate: true });
let loadedFor = "";
let override: Scopes | null = null;

export const canWriteSourceControl = () => (override ?? scopes()).sourceControlWrite;
export const canOperateThread = () => (override ?? scopes()).orchestrationOperate;
/** AuthPreviewOperateScope: opening a discovered server in the browser panel. */
export const canOperatePreview = () => (override ?? scopes()).previewOperate;

/** Tests set what the session grants without an HTTP session behind it; null restores the live read. */
export function setSourceControlScopesForTest(value: Partial<Scopes> | null) {
  override = value === null ? null : { sourceControlWrite: true, orchestrationOperate: true, previewOperate: true, ...value };
  scopes.set({ ...scopes() });
}

/** Reads the session once per connection (the card calls it when it opens). */
export function loadSourceControlScopes() {
  const url = backendUrl();
  const bearer = backendBearer();
  if (!url || !bearer || loadedFor === url) return;
  loadedFor = url;
  void fetchSessionGrant(url, bearer).then((raw) => {
    const session = raw === null ? null : parseSessionGrant(raw);
    if (!session) return;
    scopes.set({ sourceControlWrite: sessionGrantsScope(session, "source-control:write"), orchestrationOperate: sessionGrantsScope(session, "orchestration:operate"), previewOperate: sessionGrantsScope(session, "preview:operate") });
  }).catch(() => { loadedFor = ""; });
}
