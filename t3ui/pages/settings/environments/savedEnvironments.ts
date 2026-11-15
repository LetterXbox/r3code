// The environments this app keeps besides the one it is connected to: what the Environments
// panel lists under "Environments" (SavedBackendListRow). Adding one pairs it (the one-time
// pairing token is exchanged for a session credential, kept per environment like the primary's)
// and saves it; it never touches the live connection in store.ts.
import { signal, Storage } from "nsh";
import { exchangePairingToken, issueSocketUrl } from "../../../backend/auth";
import { forgetSessionBearer, loadSessionBearer, migrateLegacySessionBearer, saveSessionBearer } from "../../../backend/sessionCredential";
import { backendUrl, configureBackend } from "../../../store";
import { connectionStatusText, environmentConnections } from "../../../environments/connectionManager";
import { clearComposerDraftsEnvironment } from "../../../environments/environmentDrafts";

/** `url` is the preferred route (the one the connection uses); `alternateUrls` the others, in order (ConnectionCatalogEntry
 * target + alternateRoutes). Each route is paired on its own, so each has its own saved credential. */
/** An environment reached over SSH (SshConnectionTarget): the host, and the fixed local port its tunnel forwards. */
export interface SavedSshRoute { target: { alias: string; hostname: string; username: string | null; port: number | null }; localPort: number }
export interface SavedEnvironment { id: string; label: string; url: string; enabled: boolean; addedAt: number; alternateUrls?: string[]; ssh?: SavedSshRoute; /** A T3 Connect route (relay environment id): connects with a DPoP credential. */ relay?: { environmentId: string } }
export type EnvironmentStatus = { phase: "checking" | "connected" | "failed" | "off"; error?: string; /** The failed request's trace id (environment HTTP error body). */ traceId?: string };

const STORAGE_KEY = "savedEnvironments";
export const savedEnvironments = signal<SavedEnvironment[]>([]);
export const environmentStatuses = signal<Record<string, EnvironmentStatus>>({});
export const savedEnvironmentError = signal<string | null>(null);
let loaded = false;
const loadedSignal = signal(false);
export const savedEnvironmentsLoaded = () => loadedSignal();

/** parsePairingUrlFields: a pairing link such as https://host/pair#token=CODE fills both fields. */
export function parsePairingUrlFields(value: string): { host: string; pairingCode: string } | null {
  const text = value.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    const code = hash.get("token") ?? url.searchParams.get("token") ?? url.searchParams.get("pairingCode");
    if (!code) return null;
    return { host: url.host, pairingCode: code };
  } catch {
    return null;
  }
}

/** A host as typed (`backend.example.com`, `127.0.0.1:3773`) to the WebSocket address the app connects to. */
export function hostToServerAddress(host: string): string | null {
  const text = host.trim().replace(/\/+$/, "");
  if (text.length === 0) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${/^(localhost|127\.|10\.|192\.168\.|\[::1\])/i.test(text) ? "ws" : "wss"}://${text}`;
  try {
    const url = new URL(withScheme.replace(/^http/i, "ws"));
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
    // A credential in the host is a mistake to refuse, not to strip: it would be kept in the address.
    if (url.username || url.password || ["wsTicket", "dpop", "token", "access_token"].some((key) => url.searchParams.has(key))) return null;
    if (!/^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/i.test(url.hostname)) return null;
    if (url.pathname === "/" || url.pathname === "") url.pathname = "/ws";
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** parseRemotePairingFields (ConnectionsSettings.logic.ts): the host and code the dialog sends, or the message to show. */
export function parseRemotePairingFields(input: { host: string; pairingCode: string }): { host: string; pairingCode: string } {
  const fromUrl = parsePairingUrlFields(input.host);
  if (fromUrl) return fromUrl;
  const host = input.host.trim();
  const pairingCode = input.pairingCode.trim();
  if (!host) throw new Error("Enter a backend host.");
  if (!pairingCode) throw new Error("Enter a pairing code.");
  return { host, pairingCode };
}

function persist() {
  void Storage.setItem(STORAGE_KEY, JSON.stringify(savedEnvironments())).catch(() => undefined);
}

let loadPromise: Promise<void> | null = null;

export async function loadSavedEnvironments(): Promise<void> {
  if (loaded) return loadPromise ?? Promise.resolve();
  loaded = true;
  loadPromise = (async () => {
    try {
      const raw = await Storage.getItem(STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return;
      const list = parsed.flatMap((item): SavedEnvironment[] => {
        const value = item as Partial<SavedEnvironment> | null;
        return value && typeof value.id === "string" && typeof value.url === "string" && typeof value.label === "string"
          ? [{ id: value.id, label: value.label, url: value.url, enabled: value.enabled !== false, addedAt: typeof value.addedAt === "number" ? value.addedAt : 0,
            ...(Array.isArray(value.alternateUrls) ? { alternateUrls: value.alternateUrls.filter((url): url is string => typeof url === "string" && url !== value.url) } : {}),
            ...(value.relay && typeof value.relay.environmentId === "string" ? { relay: { environmentId: value.relay.environmentId } } : {}),
            // An SSH environment keeps its route across restarts (it was dropped here, so its tunnel never came back).
            ...(value.ssh && typeof value.ssh === "object" ? { ssh: value.ssh } : {}) }]
          : [];
      });
      savedEnvironments.update((current) => [...list.filter((item) => !current.some((existing) => existing.url === item.url)), ...current]);
      // Bearers an earlier version kept in plain Storage move into the Keychain now, not only when a route is first connected.
      for (const item of list) for (const route of [item.url, ...(item.alternateUrls ?? [])]) void migrateLegacySessionBearer(route).catch(() => undefined);
    } catch {
      // An unreadable list is an empty one.
    } finally {
      loadedSignal.set(true);
    }
  })();
  return loadPromise;
}

/** Test hook: forget what was loaded so the next load reads storage again. */
export function resetSavedEnvironments() {
  loaded = false;
  loadPromise = null;
  loadedSignal.set(false);
  savedEnvironments.set([]);
  environmentStatuses.set({});
  savedEnvironmentError.set(null);
}

function setStatus(id: string, status: EnvironmentStatus) {
  environmentStatuses.update((all) => ({ ...all, [id]: status }));
}

/** Checks that the saved credential still gets a connection ticket from the environment. */
/** Brings an SSH environment's tunnel up before it is reached (environments/sshSaved.ts sets it). */
let ensureSshRoute: ((route: SavedSshRoute) => Promise<void>) | null = null;
export function setSshRouteEnsurer(ensure: ((route: SavedSshRoute) => Promise<void>) | null) { ensureSshRoute = ensure; }
/** registry.ts removeLocked -> disconnectSsh: removing an SSH environment closes its tunnel and stops the host's managed server
 * (environments/sshSaved.ts installs it; a failure is only logged there). */
let disconnectSshRoute: ((route: SavedSshRoute) => Promise<void>) | null = null;
export function setSshRouteDisconnector(disconnect: ((route: SavedSshRoute) => Promise<void>) | null) { disconnectSshRoute = disconnect; }

export async function probeSavedEnvironment(id: string): Promise<void> {
  const environment = savedEnvironments().find((item) => item.id === id);
  if (!environment) return;
  if (!environment.enabled) { setStatus(id, { phase: "off" }); return; }
  setStatus(id, { phase: "checking" });
  try {
    if (environment.ssh && ensureSshRoute) await ensureSshRoute(environment.ssh);
    const bearer = await loadSessionBearer(environment.url);
    if (!bearer) throw new Error("Pairing expired. Add the environment again.");
    await issueSocketUrl(environment.url, bearer);
    setStatus(id, { phase: "connected" });
  } catch (error) {
    const traceId = (error as { traceId?: unknown } | null)?.traceId;
    setStatus(id, { phase: "failed", error: error instanceof Error ? error.message : "Could not reach the environment.", ...(typeof traceId === "string" ? { traceId } : {}) });
  }
}

export function probeAllSavedEnvironments() {
  for (const environment of savedEnvironments()) void probeSavedEnvironment(environment.id);
}

/**
 * The Add Environment dialog's submit. With no live connection the new environment becomes it (the
 * app has to be connected to something); otherwise it is saved beside the live one, which keeps running.
 * Throws the message to show.
 */
export async function addEnvironment(input: { host: string; pairingCode: string }): Promise<"connected" | "saved"> {
  const fields = parseRemotePairingFields(input);
  const address = hostToServerAddress(fields.host);
  if (address === null) throw new Error("Enter the backend host, such as backend.example.com.");
  if (savedEnvironments().some((item) => item.url === address) || backendUrl() === address) throw new Error("That environment is already added.");
  if (!backendUrl()) {
    configureBackend(address, fields.pairingCode);
    return "connected";
  }
  const bearer = await exchangePairingToken(address, fields.pairingCode);
  await saveSessionBearer(address, bearer);
  const environment: SavedEnvironment = { id: `saved:${crypto.randomUUID()}`, label: new URL(address).host, url: address, enabled: true, addedAt: Date.now() };
  savedEnvironments.update((all) => [...all, environment]);
  persist();
  void probeSavedEnvironment(environment.id);
  return "saved";
}

/** Pairs and registers (or updates the route of) an additional loopback environment bootstrapped by the launcher. */
export async function upsertBootstrapSavedEnvironment(input: { id?: string; label: string; endpoint: string; token: string }): Promise<void> {
  await loadSavedEnvironments();
  if (backendUrl() === input.endpoint) return;
  const bearer = await exchangePairingToken(input.endpoint, input.token);
  await saveSessionBearer(input.endpoint, bearer);
  const stableId = input.id && input.id.startsWith("saved:") ? input.id : undefined;
  const existing = savedEnvironments().find((item) => (stableId && item.id === stableId) || item.url === input.endpoint);
  if (existing) {
    if (existing.url !== input.endpoint || existing.label !== input.label) {
      savedEnvironments.update((all) => all.map((item) => (item.id === existing.id ? { ...item, label: input.label, url: input.endpoint } : item)));
      persist();
    }
    if (existing.enabled) void probeSavedEnvironment(existing.id);
    return;
  }
  const environment: SavedEnvironment = {
    id: stableId ?? `saved:${crypto.randomUUID()}`,
    label: input.label,
    url: input.endpoint,
    enabled: true,
    addedAt: Date.now(),
  };
  savedEnvironments.update((all) => [...all, environment]);
  persist();
  void probeSavedEnvironment(environment.id);
}

/** The Add environment dialog's SSH mode: save the environment the SSH flow paired (its tunnel address and route). */
export async function addSshEnvironment(input: { label: string; address: string; pairingToken: string; ssh: SavedSshRoute }): Promise<SavedEnvironment> {
  if (savedEnvironments().some((item) => item.ssh && item.ssh.target.alias === input.ssh.target.alias && item.ssh.target.username === input.ssh.target.username && item.ssh.target.port === input.ssh.target.port)) throw new Error("That environment is already added.");
  const bearer = await exchangePairingToken(input.address, input.pairingToken);
  await saveSessionBearer(input.address, bearer);
  const environment: SavedEnvironment = { id: `saved:${crypto.randomUUID()}`, label: input.label, url: input.address, enabled: true, addedAt: Date.now(), ssh: input.ssh };
  savedEnvironments.update((all) => [...all, environment]);
  persist();
  void probeSavedEnvironment(environment.id);
  return environment;
}

export function setSavedEnvironmentEnabled(id: string, enabled: boolean) {
  savedEnvironments.update((all) => all.map((item) => (item.id === id ? { ...item, enabled } : item)));
  persist();
  void probeSavedEnvironment(id);
}

/** cloud/CloudEnvironmentConnectList.tsx Add: saves a T3 Connect environment (its relay route) and turns it on. */
export function addRelayEnvironment(input: { relayEnvironmentId: string; label: string; url: string }): SavedEnvironment {
  const existing = savedEnvironments().find((item) => item.relay?.environmentId === input.relayEnvironmentId);
  if (existing) return existing;
  const environment: SavedEnvironment = { id: `saved:${crypto.randomUUID()}`, label: input.label, url: input.url, enabled: true, addedAt: Date.now(), relay: { environmentId: input.relayEnvironmentId } };
  savedEnvironments.update((all) => [...all, environment]);
  persist();
  return environment;
}

export async function removeSavedEnvironment(id: string): Promise<void> {
  const environment = savedEnvironments().find((item) => item.id === id);
  if (!environment) return;
  // platform.ts removeEnvironment: the environment's drafts go with it.
  clearComposerDraftsEnvironment(id);
  savedEnvironments.update((all) => all.filter((item) => item.id !== id));
  environmentStatuses.update((all) => { const next = { ...all }; delete next[id]; return next; });
  persist();
  if (environment.ssh && disconnectSshRoute) await disconnectSshRoute(environment.ssh).catch(() => undefined);
  await Promise.all(environmentRoutes(environment).map((url) => forgetSessionBearer(url).catch(() => undefined)));
}

/** SavedBackendListRow's status text. */
export function savedEnvironmentStatus(environment: SavedEnvironment, status: EnvironmentStatus | undefined): { text: string; tone: "muted" | "error" } {
  if (!environment.enabled) return { text: "Off", tone: "muted" };
  // A live session (environments/connectionManager.ts) reports the reference's connection states.
  const live = environmentConnections()[environment.id];
  if (live) return { text: connectionStatusText(live), tone: live.phase === "error" || live.phase === "unsupported" || (live.phase === "reconnecting" && live.error) ? "error" : "muted" };
  switch (status?.phase) {
    case "connected": return { text: "Connected", tone: "muted" };
    case "checking": return { text: "Connecting", tone: "muted" };
    case "failed": return { text: status.error ? `Connection failed: ${status.error}` : "Connection failed", tone: "error" };
    default: return { text: "Not connected", tone: "muted" };
  }
}

/** environmentMcpUrl (client-runtime connection/presentation.ts): the environment's address with path /mcp (a ws URL as its http twin). */
export function environmentMcpUrl(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address.replace(/^ws(s?):\/\//i, "http$1://"));
  } catch {
    return null;
  }
  url.pathname = "/mcp";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** connectionRoutes: every route of a saved environment, preferred first. */
export function environmentRoutes(environment: SavedEnvironment): string[] {
  return [environment.url, ...(environment.alternateUrls ?? [])];
}

function setRoutes(id: string, routes: readonly string[]) {
  if (routes.length === 0) return;
  savedEnvironments.update((all) => all.map((item) => (item.id === id ? { ...item, url: routes[0]!, alternateUrls: routes.slice(1) } : item)));
  persist();
}

/** environmentCatalog.reorderRoutes: the first becomes the route the connection uses. */
export function reorderEnvironmentRoutes(id: string, routes: readonly string[]) {
  const environment = savedEnvironments().find((item) => item.id === id);
  if (!environment) return;
  const current = environmentRoutes(environment);
  if (routes.length !== current.length || routes.some((url) => !current.includes(url))) return;
  setRoutes(id, routes);
  if (routes[0] !== environment.url) void probeSavedEnvironment(id);
}

/** environmentCatalog.removeRoute: never the last one; its credential is forgotten. */
export async function removeEnvironmentRoute(id: string, url: string): Promise<void> {
  const environment = savedEnvironments().find((item) => item.id === id);
  if (!environment) return;
  const routes = environmentRoutes(environment);
  if (routes.length < 2 || !routes.includes(url)) return;
  setRoutes(id, routes.filter((route) => route !== url));
  if (url === environment.url) void probeSavedEnvironment(id);
  await forgetSessionBearer(url).catch(() => undefined);
}

/** AddEnvironmentDialog with a route target: pairs the same machine over another address and adds it as its last route. */
export async function addEnvironmentRoute(id: string, input: { host: string; pairingCode: string }): Promise<void> {
  const environment = savedEnvironments().find((item) => item.id === id);
  if (!environment) throw new Error("That environment is no longer saved.");
  const fields = parseRemotePairingFields(input);
  const address = hostToServerAddress(fields.host);
  if (address === null) throw new Error("Enter the backend host, such as backend.example.com.");
  if (environmentRoutes(environment).includes(address)) throw new Error("That route is already added.");
  const bearer = await exchangePairingToken(address, fields.pairingCode);
  await saveSessionBearer(address, bearer);
  setRoutes(id, [...environmentRoutes(environment), address]);
}
