import { expect, test } from "nsh/test";
import {
  buildConnectAuthorizeRequestUrl, buildConnectClerkAuthorizeUrl, connectLoopbackRedirectUri, idTokenIdentity, makePkceRequest,
  parsePersistedToken, readConnectCallback, readTokenResponse, tokenNeedsRefresh,
} from "./connectAuth";
import { clerkFrontendApiUrlFromPublishableKey, hasCloudPublicConfig, resolveCloudPublicConfig } from "./publicConfig";
import { beginConnectSignIn, connectAuthState, connectBearer, loadConnectSession, resetConnectSessionForTest, signOutOfConnect } from "./connectSession";

test("public config is the reference's shipped .env.example and opens the gate", () => {
  const config = resolveCloudPublicConfig();
  expect(config.clerkJwtTemplate).toBe("t3-relay");
  expect(config.relayUrl).toBe("https://relay.t3.codes");
  expect(hasCloudPublicConfig(config)).toBe(true);
  expect(hasCloudPublicConfig({ ...config, relayUrl: null })).toBe(false);
  expect(clerkFrontendApiUrlFromPublishableKey(config.clerkPublishableKey!)).toBe("https://clerk.t3.codes");
});

test("authorize URLs match packages/shared connectAuth", () => {
  const parsed = new URL(buildConnectAuthorizeRequestUrl({ hostedAppUrl: "https://app.t3.codes", state: "s", challenge: "c", loopbackPort: 34338 }));
  expect(parsed.origin).toBe("https://app.t3.codes");
  expect(parsed.pathname).toBe("/connect");
  expect(parsed.search).toBe("");
  expect(parsed.hash).toBe("#state=s&challenge=c&port=34338");
  expect(connectLoopbackRedirectUri(34338)).toBe("http://127.0.0.1:34338/callback");
  const clerk = new URL(buildConnectClerkAuthorizeUrl({ authorizationEndpoint: "https://clerk.t3.codes/oauth/authorize", clientId: "id", redirectUri: "http://127.0.0.1:34338/callback", scopes: ["openid", "email"], state: "s", challenge: "c" }));
  expect(clerk.searchParams.get("scope")).toBe("openid email");
  expect(clerk.searchParams.get("code_challenge_method")).toBe("S256");
});

test("the loopback callback is read and checked against the state", () => {
  expect(readConnectCallback("https://app.t3.codes/connect", "s")).toBe(null);
  expect(readConnectCallback("http://127.0.0.1:34338/callback?code=abc&state=s", "s")).toEqual({ kind: "code", code: "abc" });
  expect(readConnectCallback("http://127.0.0.1:34338/callback?code=abc&state=x", "s")).toEqual({ kind: "invalid" });
  expect(readConnectCallback("http://127.0.0.1:34338/callback?error=access_denied", "s")).toEqual({ kind: "error", message: "access_denied" });
});

test("pkce, token responses and persistence", async () => {
  const pkce = await makePkceRequest();
  expect(pkce.verifier.length).toBe(43);
  expect(pkce.challenge.length).toBe(43);
  expect(pkce.state === pkce.verifier).toBe(false);
  const idToken = `x.${btoa(JSON.stringify({ email: "a@b.c" })).replace(/=+$/u, "")}.y`;
  expect(idTokenIdentity(idToken)).toBe("a@b.c");
  const token = readTokenResponse({ access_token: "A", refresh_token: "R", expires_in: 60, id_token: idToken }, 1000);
  expect(token).toEqual({ accessToken: "A", refreshToken: "R", expiresAtEpochMs: 61000, identity: "a@b.c" });
  expect(tokenNeedsRefresh(token, 0)).toBe(true);
  expect(readTokenResponse({ access_token: "B", expires_in: 3600 }, 0, "R").refreshToken).toBe("R");
  expect(parsePersistedToken(JSON.stringify(token))).toEqual(token);
  expect(parsePersistedToken("nope")).toBe(null);
});

test("sign-in exchanges the code with PKCE, stores the token, signs out", async () => {
  resetConnectSessionForTest();
  await signOutOfConnect();
  resetConnectSessionForTest();
  await loadConnectSession();
  expect(connectAuthState().status).toBe("signed-out");
  const sent: { url: string; body: string }[] = [];
  const fetcher = async (url: string, init: { body: string }) => {
    sent.push({ url, body: init.body });
    return { ok: true, status: 200, json: async () => ({ access_token: "tok", refresh_token: "ref", expires_in: 3600 }) };
  };
  const request = await beginConnectSignIn(fetcher as any);
  expect(request.url.startsWith("https://app.t3.codes/connect#state=")).toBe(true);
  await request.finish("the-code");
  expect(sent[0].url).toBe("https://clerk.t3.codes/oauth/token");
  const body = new URLSearchParams(sent[0].body);
  expect(body.get("grant_type")).toBe("authorization_code");
  expect(body.get("code")).toBe("the-code");
  expect(body.get("client_id")).toBe("hzxSgY2cH10sDU2r");
  expect((body.get("code_verifier") ?? "").length).toBe(43);
  expect(connectAuthState().status).toBe("signed-in");
  expect(await connectBearer(fetcher as any)).toBe("tok");
  await signOutOfConnect();
  expect(connectAuthState().status).toBe("signed-out");
  expect(await connectBearer(fetcher as any)).toBe(null);
});

import { closeConnectSignIn, connectSignInOpen, handleConnectNavigation, openConnectSignIn } from "./ConnectSignIn";

test("the sign-in dialog ignores ordinary navigation and closes on a bad callback", async () => {
  await openConnectSignIn();
  expect(connectSignInOpen()).toBe(true);
  expect(handleConnectNavigation("https://app.t3.codes/connect")).toBe(false);
  expect(connectSignInOpen()).toBe(true);
  expect(handleConnectNavigation("http://127.0.0.1:34338/callback?code=x&state=wrong")).toBe(true);
  expect(connectSignInOpen()).toBe(false);
  closeConnectSignIn();
});
