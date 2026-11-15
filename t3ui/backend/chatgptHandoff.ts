// CodexSetupSection.tsx reconnect for a remote environment (readSignInRouting.primaryAuthEnvironmentId): the remote
// environment hands out its saved profile registration (provider.chatgpt.reconnect-profile), the loopback primary runs the
// ChatGPT sign-in (provider.chatgpt.handoff.subscribe, phase "auth" states then "finished" with the transferred profile),
// and the profile is imported into the remote environment (provider.chatgpt.import-profile).
import { parseProviderAuthState, type ProviderAuthState } from "./providerSetup";

export interface HandoffTransports {
  remote: (method: string, payload: unknown) => Promise<unknown>;
  primarySubscribe: (method: string, payload: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void) => () => void;
}

/** readSignInRouting: hand the sign-in to the primary when the target is remote and the primary is a connected loopback server. */
export function shouldHandOffToPrimary(input: { targetUrl: string | null; primaryUrl: string | null; primaryConnected: boolean }): boolean {
  return !isLoopbackUrl(input.targetUrl) && input.primaryConnected && isLoopbackUrl(input.primaryUrl);
}
export function isLoopbackUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127\./.test(host);
  } catch { return false; }
}

let attemptSerial = 0;
/**
 * Runs one handoff. `onAuth` receives each primary sign-in state; resolves once the profile is imported, rejects with the
 * reference's copy when the sign-in fails, is cancelled or the stream is interrupted. Returns a cancel.
 */
export function runChatGptHandoff(transports: HandoffTransports, input: {
  instanceId: string; methodId: string; remoteEnvironmentId: string; returnUrl: string;
  onAuth: (state: ProviderAuthState) => void;
}): { done: Promise<void>; cancel: () => void } {
  let stop: (() => void) | null = null;
  let cancelled = false;
  const done = (async () => {
    const profile = await transports.remote("provider.chatgpt.reconnect-profile", { instanceId: input.instanceId, methodId: input.methodId });
    if (cancelled) return;
    const attemptId = `handoff:${Date.now()}:${++attemptSerial}`;
    const transferred = await new Promise<unknown>((resolve, reject) => {
      stop = transports.primarySubscribe("provider.chatgpt.handoff.subscribe", {
        instanceId: input.instanceId, environmentId: input.remoteEnvironmentId, attemptId, returnUrl: input.returnUrl, profile: profile ?? null,
      }, (value) => {
        const state = value && typeof value === "object" ? value as { phase?: unknown; state?: unknown; profile?: unknown } : {};
        if (state.phase === "finished") { resolve(state.profile); return; }
        if (state.phase !== "auth") return;
        let auth: ProviderAuthState;
        try { auth = parseProviderAuthState(state.state, input.instanceId); } catch { return; }
        input.onAuth(auth);
        if (auth.phase === "failed" || auth.phase === "cancelled") reject(new Error(auth.message ?? "ChatGPT sign-in could not finish. Try again."));
      }, () => reject(new Error("ChatGPT sign-in on the primary environment was interrupted. Try again.")));
    });
    (stop as (() => void) | null)?.();
    stop = null;
    if (cancelled) return;
    await transports.remote("provider.chatgpt.import-profile", { instanceId: input.instanceId, profile: transferred });
  })();
  return { done, cancel: () => { cancelled = true; stop?.(); stop = null; } };
}
