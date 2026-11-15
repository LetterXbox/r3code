// PermissionUpdateNotice.ts: asks once per environment, until dismissed, to pair again when the session still carries the permissions
// from before scopes were introduced (sessionHasLegacyPermissions in packages/contracts auth.ts). The session is the one
// `GET /api/auth/session` reports.
import { effect, Storage, untracked } from "nsh";
import { fetchSessionGrant, type SessionGrantShape } from "../../backend/providers";
import { backendBearer, backendConnectionGeneration, backendStatus, backendUrl, openSettings } from "../../store";
import { serverEnvironment } from "../../pages/settings/settingsState";
import { closeToast, showToast } from "../toast/toastState";

// legacyScopes and legacyParents (contracts auth.ts): the scopes older servers hand out, and the narrower ones they stand for.
const LEGACY_SCOPES = new Set(["orchestration:read", "orchestration:operate", "terminal:operate", "review:write", "access:read", "access:write", "relay:read", "relay:write"]);
const LEGACY_PARENTS = new Set(["orchestration:read", "orchestration:operate", "terminal:operate"]);

export function sessionHasLegacyPermissions(session: SessionGrantShape): boolean {
  const permissions = session.permissions;
  return session.authenticated && permissions !== undefined && permissions.every((scope) => LEGACY_SCOPES.has(scope)) && permissions.some((scope) => LEGACY_PARENTS.has(scope));
}

export const permissionDismissalKey = (environmentUrl: string) => `permission-update:v1:${environmentUrl}`;

export const PERMISSION_NOTICE_COPY = {
  title: (label: string) => `Permissions have changed for ${label}`,
  description: "This connection still uses the old permissions, so some actions may no longer be available. Pair again using a new link with the permissions you need.",
} as const;

const shown = new Set<string>();

/** Raises the notice for `environmentUrl` unless it was dismissed or already shown this session. */
export async function showPermissionNotice(environmentUrl: string, label: string, openAccess: () => void = () => openSettings("/settings/access")): Promise<boolean> {
  if (shown.has(environmentUrl)) return false;
  const key = permissionDismissalKey(environmentUrl);
  if (await Storage.getItem(key).catch(() => null)) return false;
  shown.add(environmentUrl);
  const persist = () => { void Storage.setItem(key, "true").catch(() => undefined); };
  const id = `permission-update:${environmentUrl}`;
  const dismiss = () => { persist(); closeToast(id); };
  showToast({
    id,
    title: PERMISSION_NOTICE_COPY.title(label),
    description: PERMISSION_NOTICE_COPY.description,
    timeoutMs: 0,
    onClose: persist,
    actions: [
      { label: "Dismiss", variant: "ghost", run: dismiss },
      { label: "Open Sharing & access", run: () => { dismiss(); openAccess(); } },
    ],
  });
  return true;
}

export function resetPermissionNoticeForTest() { shown.clear(); }

let installed = false;

export function installPermissionUpdateNotice() {
  if (installed) return;
  installed = true;
  effect(() => {
    const connected = backendStatus() === "connected";
    backendConnectionGeneration();
    const url = backendUrl();
    const bearer = backendBearer();
    if (!connected || !bearer) return;
    untracked(() => {
      void fetchSessionGrant(url, bearer).then((session) => {
        if (session && sessionHasLegacyPermissions(session)) {
          const label = serverEnvironment()?.label;
          return showPermissionNotice(url, typeof label === "string" && label ? label : "this environment");
        }
        return false;
      }).catch(() => false);
    });
  });
}
