// fileAccess.ts: useFilesystemReadAccess / resolveFilesystemReadAccess for the primary environment's file surfaces
// (FilePreviewPanel, useDirectoryEntries): checking while the session has not answered and the environment is
// connecting or connected, the connection's error (or "This environment is not connected.") when it cannot finish,
// and "This connection cannot read host files." once the session answers without filesystem:read.
import { backendStatus } from "../../store";
import { FILESYSTEM_READ_SCOPE, sessionScopeState, startSessionScopes, type ScopeState } from "../../backend/sessionScopes";

export interface FilesystemReadAccess { canReadFiles: boolean; isPending: boolean; error: string | null }

export const HOST_FILES_UNREADABLE = "This connection cannot read host files.";
export const ENVIRONMENT_NOT_CONNECTED = "This environment is not connected.";

export function resolveFilesystemReadAccess(scope: ScopeState, status: string): FilesystemReadAccess {
  if (scope === "granted") return { canReadFiles: true, isPending: false, error: null };
  if (scope === "denied") return { canReadFiles: false, isPending: false, error: null };
  const isPending = status === "connected" || status === "connecting" || status === "reconnecting";
  return { canReadFiles: false, isPending, error: isPending ? null : ENVIRONMENT_NOT_CONNECTED };
}

export function filesystemReadAccess(): FilesystemReadAccess {
  startSessionScopes();
  return resolveFilesystemReadAccess(sessionScopeState(FILESYSTEM_READ_SCOPE), backendStatus());
}

/** The text a gated surface shows instead of its content, or null when it may read. */
export function fileAccessBlockedText(access: FilesystemReadAccess): string | null {
  if (access.canReadFiles) return null;
  if (access.isPending) return "Checking file access...";
  return access.error ?? HOST_FILES_UNREADABLE;
}
