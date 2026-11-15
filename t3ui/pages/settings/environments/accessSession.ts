// The connected environment's session as the Sharing & access page reads it (`GET /api/auth/session`,
// AuthSessionState in packages/contracts/src/auth.ts): its auth policy (which decides the Network access
// row of a client without the desktop bridge), and the permissions it holds (which the Create pairing
// link dialog may delegate and the Permissions list shows).
import { signal } from "nsh";
import { backendBearer, backendStatus, backendUrl } from "../../../store";

export interface AccessSession {
  status: "idle" | "loading" | "ready" | "failed";
  authenticated: boolean;
  /** `auth.policy`: desktop-managed-local, loopback-browser, remote-reachable or unsafe-no-auth. */
  policy: string | null;
  scopes: string[];
}

export const EMPTY_SESSION: AccessSession = { status: "idle", authenticated: false, policy: null, scopes: [] };
export const accessSession = signal<AccessSession>(EMPTY_SESSION);

const dict = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const list = (value: unknown): string[] | null => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : null);

/** AuthSessionState, read leniently: `permissions` when the server sends them, else the legacy `scopes`. */
export function parseAccessSession(value: unknown): AccessSession | null {
  const data = dict(value);
  if (!data || typeof data.authenticated !== "boolean") return null;
  const auth = dict(data.auth);
  return {
    status: "ready",
    authenticated: data.authenticated,
    policy: typeof auth?.policy === "string" ? auth.policy : null,
    scopes: list(data.permissions) ?? list(data.scopes) ?? [],
  };
}

/** sessionGrantsScope: the granted permissions, with the legacy fallback to orchestration:operate. */
export function sessionHolds(session: AccessSession, scope: string): boolean {
  return session.authenticated && session.scopes.includes(scope);
}

function sessionUrl(): string {
  const url = new URL(backendUrl());
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/api/auth/session";
  url.search = "";
  url.hash = "";
  return url.toString();
}

let inflight = 0;

/** Reads the session once for the page; a failure leaves `failed`, which the page retries on its next visit. */
export async function loadAccessSession(): Promise<void> {
  const bearer = backendBearer();
  if (backendStatus() !== "connected" || !bearer) {
    accessSession.set(EMPTY_SESSION);
    return;
  }
  const ticket = ++inflight;
  accessSession.update((state) => ({ ...state, status: "loading" }));
  try {
    const response = await fetch(sessionUrl(), { headers: { authorization: `Bearer ${bearer}` } });
    const parsed = response.ok ? parseAccessSession(await response.json()) : null;
    if (ticket === inflight) accessSession.set(parsed ?? { ...EMPTY_SESSION, status: "failed" });
  } catch {
    if (ticket === inflight) accessSession.set({ ...EMPTY_SESSION, status: "failed" });
  }
}
