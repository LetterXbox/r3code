// The Providers page's setup calls follow the settings scope (scopeState.ts): a selected saved environment is set up over
// its own session, as the reference's CodexSetupSection targets `environmentId`. A ChatGPT reconnect on a remote saved
// environment hands the sign-in to the loopback primary (backend/chatgptHandoff.ts).
import { ProviderSetupClient, type ProviderAuthState } from "../../../backend/providerSetup";
import { runChatGptHandoff, shouldHandOffToPrimary } from "../../../backend/chatgptHandoff";
import { environmentConfigs, environmentConnections, managedEnvironment, requestEnvironment, subscribeEnvironment } from "../../../environments/connectionManager";
import { record } from "../../../backend/client";
import { backendStatus, backendUrl, subscribeBackend } from "../../../store";
import { scopeSavedEnvironmentId } from "../scopeState";
import type { ProviderSetupApi } from "./data";

const clients = new Map<string, ProviderSetupClient>();
function clientFor(environmentId: string): ProviderSetupClient {
  let client = clients.get(environmentId);
  if (!client) {
    client = new ProviderSetupClient({
      request: (method, payload) => requestEnvironment(environmentId, method, payload),
      subscribe: (method, payload, onValue, onError) => subscribeEnvironment(environmentId, method, payload, onValue, onError),
      generation: () => (environmentConnections()[environmentId]?.phase === "connected" ? 1 : 0),
    });
    clients.set(environmentId, client);
  }
  return client;
}

/** Handoff auth states, delivered to the page's auth subscribers of that instance. */
const handoffListeners = new Map<string, Set<(state: ProviderAuthState) => void>>();

export function scopedProviderSetup(primary: ProviderSetupApi, target: () => string | null = scopeSavedEnvironmentId): ProviderSetupApi {
  const pick = () => { const id = target(); return id ? clientFor(id) : null; };
  return {
    subscribeAuth(instanceId, onState, onError) {
      const remote = pick();
      const stop = remote ? remote.subscribeAuth(instanceId, onState, onError) : primary.subscribeAuth(instanceId, onState, onError);
      const set = handoffListeners.get(instanceId) ?? new Set();
      set.add(onState);
      handoffListeners.set(instanceId, set);
      return () => { set.delete(onState); stop(); };
    },
    subscribeInstall: (id, onState, onError) => pick()?.subscribeInstall(id, onState, onError) ?? primary.subscribeInstall(id, onState, onError),
    async startAuth(instanceId, options) {
      const environmentId = target();
      if (!environmentId) return primary.startAuth(instanceId, options);
      const remoteEnvironmentId = record(environmentConfigs()[environmentId]?.environment)?.environmentId;
      if (options?.methodId && typeof remoteEnvironmentId === "string" && shouldHandOffToPrimary({
        targetUrl: managedEnvironment(environmentId)?.url ?? null, primaryUrl: backendUrl() || null, primaryConnected: backendStatus() === "connected",
      })) {
        return await new Promise<ProviderAuthState>((resolve, reject) => {
          let first = true;
          const handoff = runChatGptHandoff({
            remote: (method, payload) => requestEnvironment(environmentId, method, payload),
            primarySubscribe: subscribeBackend,
          }, {
            instanceId, methodId: options.methodId!, remoteEnvironmentId, returnUrl: `t3code://app/settings/providers?instanceId=${encodeURIComponent(instanceId)}`, // server providerAuthReturnUrl: t3code://app + /settings/*, instanceId kept
            onAuth: (state) => {
              for (const listener of handoffListeners.get(instanceId) ?? []) listener(state);
              if (first) { first = false; resolve(state); }
            },
          });
          handoff.done.catch((error: unknown) => { if (first) { first = false; reject(error); } });
        });
      }
      return clientFor(environmentId).startAuth(instanceId, options);
    },
    respondAuth: (id, flowId, interactionId, response) => pick()?.respondAuth(id, flowId, interactionId, response) ?? primary.respondAuth(id, flowId, interactionId, response),
    completeAuth: (id, flowId, url) => pick()?.completeAuth(id, flowId, url) ?? primary.completeAuth(id, flowId, url),
    cancelAuth: (id, flowId) => pick()?.cancelAuth(id, flowId) ?? primary.cancelAuth(id, flowId),
    logout: (id) => pick()?.logout(id) ?? primary.logout(id),
    removeAuthMethod: (id, methodId) => pick()?.removeAuthMethod(id, methodId) ?? primary.removeAuthMethod(id, methodId),
    startInstall: (id) => pick()?.startInstall(id) ?? primary.startInstall(id),
    cancelInstall: (id, operationId) => pick()?.cancelInstall(id, operationId) ?? primary.cancelInstall(id, operationId),
    removeInstall: (id) => pick()?.removeInstall(id) ?? primary.removeInstall(id),
  };
}
