// The connection lifecycle as the web shows it: ConnectionStatusDot's phases, the composer banner's "<label> is reconnecting" /
// "<label> is offline" with Reconnect (useSystemComposerBanners.tsx, held back by ENVIRONMENT_RECONNECT_WARNING_GRACE_MS), the
// pairing gate's copy when the session is refused, and versionSkew.ts's mismatch. Pure: the coordinator and the tests share it.
import type { BackendStatus } from "../../store";

/** The web's EnvironmentConnectionPhase. */
export type ConnectionPhase = "disconnected" | "connecting" | "reconnecting" | "connected" | "error";

/** The version of the T3 Code server this client is built against (apps/web package version; third_party/t3code-server pins the same). */
export const CLIENT_APP_VERSION = "0.1.8";

/** ChatView.logic.ts: a reconnect shorter than this raises no warning. */
export const ENVIRONMENT_RECONNECT_WARNING_GRACE_MS = 2_000;

/** A connection that was up and went down is reconnecting; the first connect of a session is connecting. */
export function connectionPhase(status: BackendStatus, hasConnected: boolean): ConnectionPhase {
  if (status === "connecting") return hasConnected ? "reconnecting" : "connecting";
  return status;
}

/** True once the server refused the saved session (store.ts: HTTP 401/403 while connecting). */
export function isAuthRefused(error: string | null | undefined): boolean {
  return typeof error === "string" && error.includes("authorization expired");
}

export function connectionPhaseDotClassName(phase: ConnectionPhase): string {
  switch (phase) {
    case "connected": return "bg-success";
    case "connecting":
    case "reconnecting": return "bg-warning";
    case "error": return "bg-destructive";
    default: return "bg-muted-foreground";
  }
}

/** The grey dot of a connection that is not up is drawn at 40% (bg-muted-foreground/40). */
export const connectionPhaseDotOpacity = (phase: ConnectionPhase) => (phase === "connected" || phase === "connecting" || phase === "reconnecting" || phase === "error" ? 1 : 0.4);

export function connectionPhasePings(phase: ConnectionPhase): boolean {
  return phase === "connecting" || phase === "reconnecting";
}

export interface ConnectionNotice {
  id: string;
  variant: "warning" | "error";
  title: string;
  description?: string;
  /** "Reconnect" re-opens the saved session; "Open Environments" leads to the pairing flow in Settings. */
  action: "Reconnect" | "Open Environments" | null;
}

export const CONNECTION_NOTICE_ID = "environment-connection";

/**
 * What the user is told about the connection right now, or null. A reconnect is shown only once held for the grace period;
 * a connection that never came up and has no session to resume (disconnected) is the thread view's "Connect an environment".
 */
export function connectionNotice(input: { phase: ConnectionPhase; label: string; error: string | null; graceElapsed: boolean; hasSession: boolean }): ConnectionNotice | null {
  const { phase, label, error } = input;
  if (phase === "error" && isAuthRefused(error)) {
    return { id: CONNECTION_NOTICE_ID, variant: "error", title: "Pair with this environment", ...(error ? { description: error } : {}), action: "Open Environments" };
  }
  if (phase === "reconnecting") {
    if (!input.graceElapsed) return null;
    return { id: CONNECTION_NOTICE_ID, variant: "warning", title: `${label} is reconnecting`, ...(error ? { description: error } : {}), action: null };
  }
  if (phase === "error" && input.hasSession) {
    return { id: CONNECTION_NOTICE_ID, variant: "error", title: `${label} is offline`, ...(error ? { description: error } : {}), action: "Reconnect" };
  }
  return null;
}

// --- versionSkew.ts ---------------------------------------------------------------------------------------------------

export interface VersionMismatch { clientVersion: string; serverVersion: string; hint: string }

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(version: string) {
  const match = SEMVER.exec(version);
  return match ? { core: [Number(match[1]), Number(match[2]), Number(match[3])] as const, prerelease: match[4]?.split(".") ?? [] } : null;
}

function compareCore(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return (a[index] ?? 0) < (b[index] ?? 0) ? -1 : 1;
  return 0;
}

/** The server is behind the client (a newer server is not a mismatch), or differs at all when a version is not semver. */
export function resolveVersionMismatch(serverVersion: string | null | undefined, clientVersion: string = CLIENT_APP_VERSION): VersionMismatch | null {
  const client = clientVersion?.trim();
  const server = serverVersion?.trim();
  if (!client || !server) return null;
  const clientParsed = parse(client.replace(/[-+].*$/, ""));
  const serverParsed = parse(server.replace(/[-+].*$/, ""));
  const nightly = parse(client)?.prerelease[0] === "nightly" && parse(server)?.prerelease[0] === "nightly";
  let behind: boolean;
  if (clientParsed && serverParsed) {
    if (nightly) {
      // Nightly builds compare by their full version: the core first, then the prerelease tail.
      const core = compareCore(parse(server)!.core, parse(client)!.core);
      behind = core !== 0 ? core < 0 : parse(server)!.prerelease.join(".") < parse(client)!.prerelease.join(".");
    } else behind = compareCore(serverParsed.core, clientParsed.core) < 0;
  } else behind = server !== client;
  return behind ? { clientVersion: client, serverVersion: server, hint: "Version mismatch. Try syncing the client and server to the same R3 Code version." } : null;
}
