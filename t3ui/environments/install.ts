// Keeps one live session per enabled saved environment (connectionManager.ts) and folds their shells
// into the store's lists. Installed by App.tsx only, so fixtures and tests never open a socket.
import { effect, untracked } from "nsh";
import { backendUrl, fetchEnvironmentDescriptor, orchestrationProtocolCompatibilityError, refreshMergedShell } from "../store";
import { loadSavedEnvironments, savedEnvironments } from "../pages/settings/environments/savedEnvironments";
import { remoteShellRevision, setEnvironmentDescriptorCheck, setEnvironmentRelayRoute, syncEnvironments } from "./connectionManager";
import { openRelaySocketUrl, type RelayConnectAnswer } from "../backend/relayRoute";
import { connectRelayEnvironment, createDpopProof } from "../cloud/relayDiscovery";
import { connectAuthState } from "../cloud/connectSession";
import { setClientOwnerAccount } from "../backend/auth";
import { requireConnectSession } from "../cloud/connectSession";
import { installSshEnvironments } from "./sshSaved";
import { installMissingThreadRoute } from "./missingThreadRoute";

let installed = false;

export function installEnvironmentConnections() {
  if (installed) return;
  installed = true;
  installSshEnvironments();
  installMissingThreadRoute();
  setEnvironmentDescriptorCheck(async (url) => {
    const descriptor = await fetchEnvironmentDescriptor(url);
    return { descriptor, blocked: orchestrationProtocolCompatibilityError(descriptor)?.detail ?? null };
  });
  // T3 Connect routes: the relay's DPoP connect, then the environment's DPoP token, ticket and upgrade proof.
  setEnvironmentRelayRoute(async (relayEnvironmentId) => {
    // CloudSession.clerkToken: no signed-in T3 Connect session is a blocked (authentication) attempt, not one to retry.
    await requireConnectSession();
    return openRelaySocketUrl(relayEnvironmentId, {
      connect: async (id) => (await connectRelayEnvironment(id)) as RelayConnectAnswer,
      createProof: createDpopProof,
    });
  });
  // readClientOwnerParams: the signed-in T3 Connect account, hashed onto every socket URL.
  setClientOwnerAccount(() => { const auth = connectAuthState(); return auth.status === "signed-in" ? auth.userId : null; });
  void loadSavedEnvironments();
  effect(() => {
    const primary = backendUrl();
    // The primary connection is never duplicated as a saved session.
    const list = savedEnvironments().filter((item) => item.url !== primary);
    untracked(() => syncEnvironments(list));
  });
  effect(() => {
    remoteShellRevision();
    untracked(() => refreshMergedShell());
  });
}
