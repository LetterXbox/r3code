// packages/shared/src/codexAuthHandoff.ts + codexAuthCallback.ts + apps/web/src/providerAuthDelivery.ts: the hosted web
// app (or another client) hands a ChatGPT sign-in to this computer with `t3code://auth/codex?request=...`; the
// launcher (tools/codex_auth.py; NSH has no listening sockets) listens on the request's 127.0.0.1 callback port,
// opens the sign-in in the browser, and redirects the callback to the return address with `#codex-auth=<delivery>`.
// A return address in this app (`t3code://app/...`) comes back here as a link, and the delivery's one-time code goes
// to its environment (`provider.auth.complete`).
import { readFile, rename, writeFile } from "fs/promises";
import process from "process";
import { providerAuthReturnUrl } from "./promptLinkParse";

export interface CodexAuthHandoff { authorizationUrl: string; returnUrl: string; environmentId: string; instanceId: string; flowId: string }
export interface CodexAuthDelivery { environmentId: string; instanceId: string; flowId: string; callbackUrl: string; returnHash: string; returnUrl: string }

const APP_SCHEME = /^t3code(?:-[a-z]+)?:$/;

export function codexAuthorizationRequest(value: string) {
  const url = new URL(value);
  if (value.length > 16_384 || url.origin !== "https://auth.openai.com" || url.pathname !== "/api/accounts/authorize" || url.username || url.password || url.hash) {
    throw new Error("Invalid ChatGPT sign-in request.");
  }
  const single = (key: string) => {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || !values[0]) throw new Error("Invalid ChatGPT sign-in request.");
    return values[0];
  };
  const redirectUri = single("redirect_uri");
  const redirect = new URL(redirectUri);
  const state = single("state");
  if (
    !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/auth\/callback$/u.test(redirectUri) || Number(redirect.port) > 65_535
    || !/^[\w-]{16,128}$/u.test(state) || single("response_type") !== "code" || single("code_challenge_method") !== "S256"
    || !/^[\w-]{43}$/u.test(single("code_challenge")) || !/^(dynamic_agent_client|oaiapp_[\w-]+)$/u.test(single("client_id"))
  ) throw new Error("Invalid ChatGPT sign-in request.");
  return { authorizationUrl: url.toString(), redirectUri, state };
}

const str = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max;

/** readCodexAuthHandoff, with this app's scheme (t3code, or t3code-<name> for a test copy). */
export function readCodexAuthHandoff(value: string): CodexAuthHandoff | undefined {
  try {
    const url = new URL(value);
    if (value.length > 32_768 || !APP_SCHEME.test(url.protocol) || url.host !== "auth" || url.pathname !== "/codex" || url.username || url.password || url.hash || url.searchParams.getAll("request").length !== 1) return undefined;
    const input = JSON.parse(url.searchParams.get("request") ?? "") as Record<string, unknown>;
    if (!str(input.authorizationUrl, 16_384) || typeof input.returnUrl !== "string" || input.returnUrl.length > 4_096 || !str(input.environmentId, 512) || !str(input.instanceId, 512) || !str(input.flowId, 128)) return undefined;
    const handoff = input as unknown as CodexAuthHandoff;
    codexAuthorizationRequest(handoff.authorizationUrl);
    if (!providerAuthReturnUrl(handoff.returnUrl)) return undefined;
    return { authorizationUrl: handoff.authorizationUrl, returnUrl: handoff.returnUrl, environmentId: handoff.environmentId, instanceId: handoff.instanceId, flowId: handoff.flowId };
  } catch {
    return undefined;
  }
}

/** readCodexAuthDelivery. */
export function readCodexAuthDelivery(value: string): CodexAuthDelivery | undefined {
  try {
    const url = new URL(value);
    if (!url.hash.startsWith("#codex-auth=") || url.hash.length > 32_768) return undefined;
    const input = JSON.parse(decodeURIComponent(url.hash.slice("#codex-auth=".length))) as Record<string, unknown>;
    if (!str(input.environmentId, 512) || !str(input.instanceId, 512) || !str(input.flowId, 128) || !str(input.callbackUrl, 16_384) || typeof input.returnHash !== "string" || input.returnHash.length > 128) return undefined;
    const destination = providerAuthReturnUrl(value);
    if (!destination) return undefined;
    const returnUrl = new URL(destination);
    returnUrl.hash = input.returnHash as string;
    const sanitized = providerAuthReturnUrl(returnUrl.toString());
    if (!sanitized) return undefined;
    return { environmentId: input.environmentId as string, instanceId: input.instanceId as string, flowId: input.flowId as string, callbackUrl: input.callbackUrl as string, returnHash: input.returnHash as string, returnUrl: sanitized };
  } catch {
    return undefined;
  }
}

export interface CodexAuthIo { write(path: string, text: string): Promise<void>; rename(from: string, to: string): Promise<void>; read(path: string): Promise<string> }
const realIo: CodexAuthIo = { write: (p, t) => writeFile(p, t), rename: (a, b) => rename(a, b), read: (p) => readFile(p, "utf8") };

export function launcherDir(): string | null {
  const file = process.env.T3GPUI_BOOTSTRAP_FILE;
  return file ? file.replace(/\/[^/]*$/, "") : null;
}

/** DesktopClerk startProviderAuthHandoff: asks the launcher to receive the callback; resolves false without one. */
export async function startCodexAuthHandoff(handoff: CodexAuthHandoff, deps: { dir?: string | null; io?: CodexAuthIo } = {}): Promise<boolean> {
  const dir = deps.dir === undefined ? launcherDir() : deps.dir;
  if (!dir) return false;
  const io = deps.io ?? realIo;
  const request = codexAuthorizationRequest(handoff.authorizationUrl);
  const destination = providerAuthReturnUrl(handoff.returnUrl);
  if (!destination) return false;
  const body = {
    id: request.state,
    authorizationUrl: request.authorizationUrl,
    redirectUri: request.redirectUri,
    state: request.state,
    destination,
    delivery: { environmentId: handoff.environmentId, instanceId: handoff.instanceId, flowId: handoff.flowId },
  };
  const name = `codex-auth-request-${request.state}.json`;
  await io.write(`${dir}/${name}.tmp`, JSON.stringify(body));
  await io.rename(`${dir}/${name}.tmp`, `${dir}/${name}`);
  return true;
}
