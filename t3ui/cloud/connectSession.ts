// The T3 Connect account on this client: the OAuth token from the native sign-in (connectAuth.ts), kept across
// restarts the way sessionCredential.ts keeps environment bearers, refreshed before expiry (CliTokenManager's
// getExisting), and removed on sign-out. Tokens are never logged or shown.
import { signal, Storage } from "nsh";
import { secureStorage } from "../backend/secureStorage";
import {
  buildConnectAuthorizeRequestUrl, CONNECT_LOOPBACK_PORT, connectLoopbackRedirectUri, DEFAULT_HOSTED_APP_URL, makePkceRequest,
  parsePersistedToken, readTokenResponse, tokenNeedsRefresh, type ConnectToken,
} from "./connectAuth";
import { clerkFrontendApiUrlFromPublishableKey, hasCloudPublicConfig, resolveCloudPublicConfig } from "./publicConfig";

const STORAGE_KEY = "t3connect:oauthToken";

/** connection/platform.ts CloudSession.clerkToken: the ConnectionBlockedError (authentication) detail of a T3 Connect route with no signed-in session. */
export const SIGN_IN_TO_CONNECT_ENVIRONMENT_DETAIL = "Sign in to T3 Connect to connect this environment.";

export type ConnectAuthState = { status: "loading" } | { status: "signed-out" } | { status: "signed-in"; identity: string | null; userId: string | null };
const state = signal<ConnectAuthState>({ status: "loading" });
export const connectAuthState = () => state();

let token: ConnectToken | null = null;
let loaded = false;

export async function loadConnectSession(): Promise<void> {
  if (loaded) return;
  loaded = true;
  // The token is a secret: it lives in the Keychain (backend/secureStorage.ts). One kept in plain Storage by an
  // earlier version moves there once and the plain copy goes.
  let raw: string | null = null;
  try { raw = await secureStorage().isEncryptionAvailable() ? await secureStorage().get(STORAGE_KEY) : null; } catch { raw = null; }
  if (raw === null) {
    const legacy = await Storage.getItem(STORAGE_KEY).catch(() => null);
    if (legacy && parsePersistedToken(legacy)) {
      try {
        if (await secureStorage().isEncryptionAvailable()) {
          await secureStorage().set(STORAGE_KEY, legacy);
          await Storage.removeItem(STORAGE_KEY).catch(() => undefined);
          raw = legacy;
        }
      } catch {
        // Secure storage cannot take it: the plain copy stays where it is, unread.
      }
    }
  }
  token = parsePersistedToken(raw);
  state.set(token ? { status: "signed-in", identity: token.identity ?? null, userId: token.userId ?? null } : { status: "signed-out" });
}

async function persist(next: ConnectToken | null): Promise<void> {
  token = next;
  // What was just signed in (or out) is the truth: a later load must not replace it with what secure storage could not keep.
  loaded = true;
  // Held in memory for this run whatever secure storage does; a failed write only means the sign-in is not kept across restarts.
  try {
    if (next) await secureStorage().set(STORAGE_KEY, JSON.stringify(next));
    else await secureStorage().remove(STORAGE_KEY);
  } catch (error) {
    console.warn("Could not keep the T3 Connect session in secure storage.", error instanceof Error ? error.message : String(error));
  }
  await Storage.removeItem(STORAGE_KEY).catch(() => undefined);
  state.set(next ? { status: "signed-in", identity: next.identity ?? null, userId: next.userId ?? null } : { status: "signed-out" });
}

function oauthConfig() {
  const config = resolveCloudPublicConfig();
  if (!hasCloudPublicConfig(config) || !config.clerkPublishableKey || !config.clerkCliOAuthClientId) return null;
  const frontendApi = clerkFrontendApiUrlFromPublishableKey(config.clerkPublishableKey);
  return { clientId: config.clerkCliOAuthClientId, tokenEndpoint: `${frontendApi}/oauth/token`, redirectUri: connectLoopbackRedirectUri(CONNECT_LOOPBACK_PORT) };
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

async function exchange(params: Record<string, string>, previousRefreshToken = "", fetcher: Fetch = fetch as unknown as Fetch): Promise<ConnectToken> {
  const config = oauthConfig();
  if (!config) throw new Error("T3 Connect is not configured.");
  const response = await fetcher(config.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) throw new Error(`T3 Connect sign-in failed (${response.status}).`);
  return readTokenResponse(await response.json(), Date.now(), previousRefreshToken);
}

/** A pending sign-in: the URL the dialog's WebView loads, and how to finish with the callback's code. */
export interface ConnectSignInRequest { url: string; state: string; finish(code: string): Promise<void> }

export async function beginConnectSignIn(fetcher?: Fetch): Promise<ConnectSignInRequest> {
  const config = oauthConfig();
  if (!config) throw new Error("T3 Connect is not configured.");
  const pkce = await makePkceRequest();
  return {
    url: buildConnectAuthorizeRequestUrl({ hostedAppUrl: DEFAULT_HOSTED_APP_URL, state: pkce.state, challenge: pkce.challenge, loopbackPort: CONNECT_LOOPBACK_PORT }),
    state: pkce.state,
    finish: async (code: string) => {
      const next = await exchange({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri, client_id: config.clientId, code_verifier: pkce.verifier }, "", fetcher);
      await persist(next);
    },
  };
}

/** The bearer for relay client routes (verifyRelayClientBearerToken accepts Clerk OAuth tokens), refreshed when due. */
export async function connectBearer(fetcher?: Fetch): Promise<string | null> {
  await loadConnectSession();
  if (!token) return null;
  if (!tokenNeedsRefresh(token, Date.now())) return token.accessToken;
  const config = oauthConfig();
  if (!config || !token.refreshToken) { await persist(null); return null; }
  try {
    const refreshed = await exchange({ grant_type: "refresh_token", refresh_token: token.refreshToken, client_id: config.clientId }, token.refreshToken, fetcher);
    await persist({ ...refreshed, ...(token.identity && !refreshed.identity ? { identity: token.identity } : {}), ...(token.userId && !refreshed.userId ? { userId: token.userId } : {}) });
    return refreshed.accessToken;
  } catch {
    await persist(null);
    return null;
  }
}

/** CloudSession.clerkToken: a T3 Connect route needs a signed-in session; without one the attempt is blocked (fatal: not retried). */
export async function requireConnectSession(fetcher?: Fetch): Promise<void> {
  if (!(await connectBearer(fetcher))) throw Object.assign(new Error(SIGN_IN_TO_CONNECT_ENVIRONMENT_DETAIL), { fatal: true });
}

export async function signOutOfConnect(): Promise<void> {
  await persist(null);
}

/** Tests only. */
export function resetConnectSessionForTest(): void {
  token = null;
  loaded = false;
  state.set({ status: "loading" });
}
