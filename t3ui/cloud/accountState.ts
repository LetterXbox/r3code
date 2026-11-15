// managedRelayState.ts for this client: the account's relay environments, mobile devices and T3 Chat link, each read
// on demand and refreshed after a change. Signed-out reads stay empty.
import { openUrl, signal } from "nsh";
import { showToast } from "../components/toast/toastState";
import {
  createT3ChatLinkRequest, getT3ChatLink, listRelayDevices, listRelayEnvironments, managedTunnelCap, managedTunnelsUsed,
  relayFailureReason, RelayRequestError, unlinkRelayEnvironment, unlinkT3Chat,
  type RelayDeviceRecord, type RelayEnvironmentRecord, type RelayT3ChatLinkResponse,
} from "./relayClient";

export interface Query<T> { data: T | null; error: string | null; pending: boolean }
const empty = <T>(): Query<T> => ({ data: null, error: null, pending: false });

function query<T>(load: () => Promise<T>) {
  const state = signal<Query<T>>(empty<T>());
  const refresh = async () => {
    state.update((current) => ({ ...current, pending: true }));
    try {
      const data = await load();
      state.set({ data, error: null, pending: false });
    } catch (cause) {
      state.update((current) => ({ ...current, pending: false, error: relayFailureReason(cause) ?? (cause instanceof Error ? cause.message : String(cause)) }));
    }
  };
  return { state: () => state(), refresh, reset: () => state.set(empty<T>()) };
}

export const relayEnvironments = query<RelayEnvironmentRecord[]>(listRelayEnvironments);
export const relayDevices = query<RelayDeviceRecord[]>(listRelayDevices);
export const relayT3ChatLink = query<RelayT3ChatLinkResponse>(getT3ChatLink);

export function resetAccountState() { relayEnvironments.reset(); relayDevices.reset(); relayT3ChatLink.reset(); }

/** useManagedTunnelUsage: managed tunnels on this account and its cap; null fields are loading or failed. */
export function managedTunnelUsage() {
  const environments = relayEnvironments.state().data;
  const t3Chat = relayT3ChatLink.state().data;
  const cap = t3Chat ? managedTunnelCap(t3Chat) : null;
  return { used: environments ? managedTunnelsUsed(environments) : null, limit: cap?.limit ?? null, upgrade: cap?.upgrade ?? null };
}

/** refreshManagedTunnelUsage. */
export function refreshTunnelUsage() { void relayEnvironments.refresh(); void relayT3ChatLink.refresh(); }

// ---- T3 Connect page: deregister (T3ConnectUserProfilePage.handleDeregister)
const deregistering = signal<string | null>(null);
export const deregisteringEnvironmentId = () => deregistering();

export async function deregisterEnvironment(environment: RelayEnvironmentRecord): Promise<boolean> {
  if (deregistering() !== null) return false;
  deregistering.set(environment.environmentId);
  try {
    await unlinkRelayEnvironment(environment.environmentId);
    void relayEnvironments.refresh();
    showToast({ type: "success", title: "Server deregistered", description: "T3 Connect access was revoked and a host space is now available." });
    return true;
  } catch (cause) {
    void relayEnvironments.refresh();
    showToast({ type: "error", title: "Could not deregister server", description: relayFailureReason(cause) ?? (cause instanceof Error ? cause.message : "Could not deregister the server.") });
    return false;
  } finally {
    deregistering.set(null);
  }
}

// ---- T3 Chat link (useT3ChatLink)
const t3ChatPending = signal<"link" | "unlink" | null>(null);
const t3ChatLinkUrl = signal<string | null>(null);
export const t3ChatLinkPending = () => t3ChatPending();
export const t3ChatPendingLinkUrl = () => t3ChatLinkUrl();

function reportT3ChatFailure(title: string, cause: unknown) {
  showToast({ type: "error", title, description: cause instanceof Error && !(cause instanceof RelayRequestError && cause.message === "timeout") ? cause.message : "Try again." });
}

export async function linkT3Chat(): Promise<void> {
  if (t3ChatPending()) return;
  t3ChatPending.set("link");
  try {
    const url = await createT3ChatLinkRequest();
    t3ChatLinkUrl.set(url);
    await openUrl(url).catch(() => undefined);
  } catch (cause) {
    reportT3ChatFailure("Could not start linking", cause);
  } finally {
    t3ChatPending.set(null);
  }
}

export async function unlinkT3ChatAccount(): Promise<void> {
  if (t3ChatPending()) return;
  t3ChatPending.set("unlink");
  try {
    await unlinkT3Chat();
    t3ChatLinkUrl.set(null);
    void relayT3ChatLink.refresh();
  } catch (cause) {
    reportT3ChatFailure("Could not unlink T3 Chat", cause);
  } finally {
    t3ChatPending.set(null);
  }
}
