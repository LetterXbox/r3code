// The Authorized clients list of the Sharing & access page: the environment's pairing links and the
// clients signed in to it (`subscribeAuthAccess`, packages/contracts auth.ts), and the three things
// the page does with them over HTTP (`/api/auth/pairing-token`, `/api/auth/pairing-links/revoke`,
// `/api/auth/clients/revoke[-others]`, packages/contracts environmentHttp.ts), signed with the
// environment's session credential.
import { signal } from "nsh";
import { backendBearer, backendStatus, backendUrl, subscribeBackend } from "../../../store";

type Dict = Record<string, unknown>;
export interface PairingLink { id: string; label?: string; scopes: string[]; createdAt: string; expiresAt: string }
export interface ClientSession {
  sessionId: string; scopes: string[]; issuedAt: string; lastConnectedAt: string | null; connected: boolean; current: boolean; subject: string;
  client: { label?: string; deviceType?: string; os?: string; browser?: string; ipAddress?: string };
}
export interface AccessState { pairingLinks: PairingLink[]; clientSessions: ClientSession[]; loaded: boolean; error: string | null }

export const EMPTY_ACCESS: AccessState = { pairingLinks: [], clientSessions: [], loaded: false, error: null };
export const accessState = signal<AccessState>(EMPTY_ACCESS);
/** The code of each link created in this session, by link id: the server never gives it back. */
export const createdCredentials = signal<Record<string, string>>({});

const dict = (value: unknown): Dict | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dict) : null);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const scopesOf = (value: Dict): string[] => {
  const raw = Array.isArray(value.scopes) ? value.scopes : Array.isArray(value.permissions) ? value.permissions : [];
  return raw.filter((item): item is string => typeof item === "string");
};

function linkOf(value: unknown): PairingLink | null {
  const link = dict(value);
  if (!link || typeof link.id !== "string" || typeof link.expiresAt !== "string") return null;
  return { id: link.id, ...(text(link.label) ? { label: text(link.label)! } : {}), scopes: scopesOf(link), createdAt: String(link.createdAt ?? link.expiresAt), expiresAt: link.expiresAt };
}

function sessionOf(value: unknown): ClientSession | null {
  const session = dict(value);
  if (!session || typeof session.sessionId !== "string") return null;
  const client = dict(session.client) ?? {};
  return {
    sessionId: session.sessionId, scopes: scopesOf(session), issuedAt: String(session.issuedAt ?? ""), subject: String(session.subject ?? ""),
    lastConnectedAt: typeof session.lastConnectedAt === "string" ? session.lastConnectedAt : null,
    connected: session.connected === true, current: session.current === true,
    client: { ...(text(client.label) ? { label: text(client.label)! } : {}), ...(text(client.deviceType) ? { deviceType: text(client.deviceType)! } : {}),
      ...(text(client.os) ? { os: text(client.os)! } : {}), ...(text(client.browser) ? { browser: text(client.browser)! } : {}), ...(text(client.ipAddress) ? { ipAddress: text(client.ipAddress)! } : {}) },
  };
}

/** One AuthAccessStreamEvent applied to the list. */
export function applyAccessEvent(state: AccessState, event: unknown): AccessState {
  const e = dict(event);
  if (!e) return state;
  const payload = e.payload;
  switch (e.type) {
    case "snapshot": {
      const snapshot = dict(payload);
      if (!snapshot) return state;
      const links = (Array.isArray(snapshot.pairingLinks) ? snapshot.pairingLinks : []).flatMap((item) => linkOf(item) ?? []);
      const sessions = (Array.isArray(snapshot.clientSessions) ? snapshot.clientSessions : []).flatMap((item) => sessionOf(item) ?? []);
      return { pairingLinks: links, clientSessions: sessions, loaded: true, error: null };
    }
    case "pairingLinkUpserted": {
      const link = linkOf(payload);
      return link ? { ...state, pairingLinks: [...state.pairingLinks.filter((item) => item.id !== link.id), link] } : state;
    }
    case "pairingLinkRemoved": {
      const id = dict(payload)?.id;
      return { ...state, pairingLinks: state.pairingLinks.filter((item) => item.id !== id) };
    }
    case "clientUpserted": {
      const session = sessionOf(payload);
      return session ? { ...state, clientSessions: [...state.clientSessions.filter((item) => item.sessionId !== session.sessionId), session] } : state;
    }
    case "clientRemoved": {
      const id = dict(payload)?.sessionId;
      return { ...state, clientSessions: state.clientSessions.filter((item) => item.sessionId !== id) };
    }
    default: return state;
  }
}

/** summarizeAuthorizedClients (ConnectionsSettings.logic.ts). */
export function summarizeAuthorizedClients(sessions: readonly unknown[], links: readonly unknown[]): string {
  return [
    `${sessions.length} ${sessions.length === 1 ? "client" : "clients"}`,
    links.length > 0 ? `${links.length} ${links.length === 1 ? "pairing link" : "pairing links"}` : null,
  ].filter((part): part is string => part !== null).join(" · ");
}

/** sortDesktopClientSessions: this device first, then connected ones, then the newest. */
export function sortClientSessions(sessions: readonly ClientSession[]): ClientSession[] {
  return [...sessions].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime();
  });
}

export const canRevokeOtherClients = (sessions: readonly ClientSession[] | null) => sessions === null || sessions.some((session) => !session.current);

/** formatExpiresInLabel (timestampFormat.ts). */
export function formatExpiresInLabel(expiresAt: string, now: number): string {
  const date = new Date(expiresAt).getTime();
  if (Number.isNaN(date)) return "";
  const total = Math.floor((date - now) / 1000);
  if (total <= 0) return "Expired";
  if (total < 5) return "Expires in a moment";
  if (total < 60) return `Expires in ${total}s`;
  if (total < 3600) { const m = Math.floor(total / 60); const s = total % 60; return s === 0 ? `Expires in ${m}m` : `Expires in ${m}m ${s}s`; }
  if (total < 86_400) {
    const h = Math.floor(total / 3600); const m = Math.floor((total % 3600) / 60); const s = total % 60;
    return `Expires in ${[`${h}h`, m > 0 ? `${m}m` : null, s > 0 ? `${s}s` : null].filter(Boolean).join(" ")}`;
  }
  const days = Math.floor(total / 86_400);
  const rest = total % 86_400;
  if (rest === 0) return `Expires in ${days}d`;
  const tail = [`${Math.floor(rest / 3600)}h`, `${Math.floor((rest % 3600) / 60)}m`, `${rest % 60}s`].filter((part) => !part.startsWith("0"));
  return `Expires in ${days}d ${tail.join(" ")}`;
}

export const PAIRING_SCOPE_OPTIONS: { scope: string; title: string; description: string }[] = [
  { scope: "orchestration:read", title: "View environment", description: "Read threads, status, checkpoints, and configuration." },
  { scope: "orchestration:operate", title: "Operate tasks", description: "Start, update, and stop tasks." },
  { scope: "settings:write", title: "Change environment settings", description: "Edit environment preferences and keybindings." },
  { scope: "providers:manage", title: "Manage providers", description: "Configure, install, sign in to, and update providers and usage sources." },
  { scope: "environment:maintain", title: "Maintain environment", description: "Update the server and control environment processes." },
  { scope: "preview:operate", title: "Control previews", description: "Open browser previews and host browser automation." },
  { scope: "diagnostics:read", title: "View diagnostics and usage", description: "Read process diagnostics, resource history, and usage totals." },
  { scope: "terminal:read", title: "View terminals", description: "Read existing terminal output and status." },
  { scope: "terminal:operate", title: "Use terminals", description: "Create terminals and send input to running shells." },
  { scope: "source-control:write", title: "Change source control", description: "Commit, push, manage branches and repositories, and change pull requests." },
  { scope: "filesystem:read", title: "Read files", description: "Browse host files, search workspaces, and inspect local changes." },
  { scope: "filesystem:write", title: "Write files", description: "Edit workspace files and save plans to disk." },
  { scope: "access:read", title: "View access", description: "Inspect pairing links and authorized clients." },
  { scope: "access:write", title: "Manage access", description: "Issue and revoke credentials for other clients." },
  { scope: "relay:read", title: "View relay", description: "Inspect managed relay connectivity." },
  { scope: "relay:write", title: "Manage relay", description: "Change managed tunnel connectivity." },
];

/** AuthStandardClientScopes: what a new pairing link grants unless the user changes it. */
export const STANDARD_CLIENT_SCOPES = PAIRING_SCOPE_OPTIONS.map((option) => option.scope);

function httpBase(): string {
  const url = new URL(backendUrl());
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function post(path: string, body?: unknown): Promise<unknown> {
  const bearer = backendBearer();
  if (!bearer) throw new Error("Connect an environment first");
  const response = await fetch(`${httpBase()}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    let message = `Request failed (HTTP ${response.status})`;
    try { const detail = dict(await response.json()); if (detail && typeof detail.message === "string") message = detail.message; } catch { /* keep the status line */ }
    throw new Error(message);
  }
  try { return await response.json(); } catch { return null; }
}

export async function createPairingLink(input: { label: string; scopes: string[] }): Promise<string> {
  const label = input.label.trim();
  const result = dict(await post("/api/auth/pairing-token", { ...(label ? { label } : {}), scopes: input.scopes }));
  if (!result || typeof result.id !== "string" || typeof result.credential !== "string") throw new Error("The environment returned no pairing link");
  createdCredentials.update((all) => ({ ...all, [result.id as string]: result.credential as string }));
  return result.id;
}

export const revokePairingLink = (id: string) => post("/api/auth/pairing-links/revoke", { id });
export const revokeClientSession = (sessionId: string) => post("/api/auth/clients/revoke", { sessionId });
/** Revokes every other client; resolves with how many it revoked (`AuthOtherClientSessionsRevokeResult.revokedCount`). */
export async function revokeOtherClients(): Promise<number> {
  const result = dict(await post("/api/auth/clients/revoke-others"));
  return typeof result?.revokedCount === "number" ? result.revokedCount : 0;
}

let stop: (() => void) | null = null;

/** Follows the environment's access list while the page is open; returns the stop function. */
export function watchAccess(): () => void {
  stop?.();
  accessState.set(EMPTY_ACCESS);
  if (backendStatus() !== "connected") return () => {};
  const unsubscribe = subscribeBackend(
    "subscribeAuthAccess", {},
    (event) => accessState.update((state) => applyAccessEvent(state, event)),
    (error) => accessState.update((state) => ({ ...state, error: error.message })),
  );
  stop = unsubscribe;
  return () => { unsubscribe(); if (stop === unsubscribe) stop = null; };
}
