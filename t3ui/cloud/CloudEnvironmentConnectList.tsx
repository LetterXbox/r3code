// components/cloud/CloudEnvironmentConnectList.tsx (CloudEnvironmentConnectRows) and cloudEnvironmentConnectionPresentation.ts:
// the account's T3 Connect environments with their relay health and an Add / Add route button, the failure toast, the
// "Could not load T3 Connect environments" retry, and the skeleton while the first list loads. Mounted on the Environments
// page (SavedEnvironmentRows CloudRemoteEnvironmentRows) and in the onboarding dialog's Connect devices step.
//
// Add runs the relay's connect call (relayDiscovery.ts connectRelayEnvironment). The reference then registers a
// RelayConnectionTarget whose supervisor opens the environment with that DPoP-bound credential (RemoteEnvironmentAuthorization
// authorizeDpop). Here the route is saved (savedEnvironments.ts relay) and connectionManager.ts opens it per attempt through
// backend/relayRoute.ts (relay connect, DPoP token exchange, DPoP ticket and upgrade proof).
import { Clipboard, effect, signal, Text, View } from "nsh";
import { showToast } from "../components/toast";
import { SettingsButton } from "../components/SettingsLayout";
import { SettingsIcon } from "../pages/settings/SettingsIcon";
import { connectionStatusText, type EnvironmentConnection } from "../environments/connectionManager";
import { addRelayEnvironment } from "../pages/settings/environments/savedEnvironments";
import { record } from "../backend/client";
import { connectRelayEnvironment, refreshRelayDiscovery, relayDiscovery, RelayDpopError, type RelayAvailability, type RelayDiscoveredEnvironment } from "./relayDiscovery";

export const EMPTY_DISCOVERY_REFRESH_INTERVAL_MS = 5_000;

export interface SavedCloudEnvironmentConnection { environmentId: string; connection: EnvironmentConnection; relayManaged: boolean; machineKind?: "desktop" | "server" }
export interface SavedCloudEnvironmentConnectionPresentation { buttonLabel: string; statusText: string; tone: "connected" | "connecting" | "error" | "idle" }

/** presentSavedCloudEnvironmentConnection, verbatim. */
export function presentSavedCloudEnvironmentConnection(connection: EnvironmentConnection): SavedCloudEnvironmentConnectionPresentation {
  const statusText = connectionStatusText(connection);
  switch (connection.phase) {
    case "connected": return { buttonLabel: "Connected", statusText, tone: "connected" };
    case "connecting": return { buttonLabel: "Connecting…", statusText, tone: "connecting" };
    case "reconnecting": return { buttonLabel: "Reconnecting…", statusText, tone: "connecting" };
    case "unsupported": return { buttonLabel: "Client not supported", statusText, tone: "idle" };
    case "error": return { buttonLabel: "Connection failed", statusText, tone: "error" };
    case "offline": return { buttonLabel: "Offline", statusText, tone: "idle" };
    case "available": return { buttonLabel: "Not connected", statusText, tone: "idle" };
  }
}

const RELAY_TUNNEL_RELEASED_MESSAGE =
  "Offline for a while, so its T3 Connect tunnel was removed. Start T3 Code on that computer and update it to the latest version to reconnect.";

/** relayOfflineReasonMessage (client-runtime relay/errorPresentation.ts). */
export function relayOfflineReasonMessage(status: { offlineReason?: string }): string | null {
  return status.offlineReason === "tunnel_released" ? RELAY_TUNNEL_RELEASED_MESSAGE : null;
}

export interface CloudRowPresentation {
  statusText: string;
  tooltip: string;
  dot: "success" | "warning" | "destructive" | "muted";
  ping: boolean;
  statusTone: "error" | "muted";
  button: { label: string; kind: "add" | "saved" | "unsupported"; disabled: boolean };
}

/** The status line, dot and button of one discovered row (the body of CloudEnvironmentConnectRows' map). */
export function presentCloudEnvironmentRow(input: {
  discovered: Pick<RelayDiscoveredEnvironment, "availability" | "status" | "error">;
  saved: SavedCloudEnvironmentConnection | undefined;
  savedWithoutRelay: boolean;
  connecting: boolean;
  anyConnecting: boolean;
  compatibilityError?: string | null;
}): CloudRowPresentation {
  const { availability, status, error } = input.discovered;
  const saved = input.saved;
  const compatibilityError = input.compatibilityError ?? null;
  const unsupported = compatibilityError !== null || saved?.connection.phase === "unsupported";
  const unsupportedDetail = compatibilityError ?? saved?.connection.error ?? null;
  const savedConnection = unsupported
    ? presentSavedCloudEnvironmentConnection({ phase: "unsupported", error: unsupportedDetail })
    : saved ? presentSavedCloudEnvironmentConnection(saved.connection) : null;
  const offlineReason = availability === "offline" && status !== null ? relayOfflineReasonMessage(status) : null;
  const dot: CloudRowPresentation["dot"] = savedConnection
    ? savedConnection.tone === "connected" ? "success" : savedConnection.tone === "connecting" ? "warning" : savedConnection.tone === "error" ? "destructive" : "muted"
    : availability === "online" ? "success" : availability === "error" ? "destructive" : availability === "checking" ? "warning" : "muted";
  const notAdded = input.savedWithoutRelay ? "Saved without T3 Connect" : "Not added";
  const statusText = unsupported && !saved
    ? `T3 Connect · ${notAdded} · Client not supported`
    : offlineReason !== null ? offlineReason
    : savedConnection ? savedConnection.statusText
    : availability === "online" ? `T3 Connect · ${notAdded} · Relay online`
    : availability === "offline" ? `T3 Connect · ${notAdded} · Relay offline`
    : availability === "checking" ? `T3 Connect · ${notAdded} · Checking relay status…`
    : error ?? `T3 Connect · ${notAdded} · Relay status unavailable`;
  const tooltip = unsupportedDetail !== null ? unsupportedDetail
    : offlineReason !== null ? offlineReason
    : savedConnection ? savedConnection.statusText
    : availability === "online" ? "Relay online" : availability === "offline" ? "Relay offline" : availability === "checking" ? "Checking relay status" : error ?? "Relay status unavailable";
  const statusTone = savedConnection?.tone === "error" || (savedConnection?.tone === "connecting" && saved?.connection.error) || (savedConnection === null && availability === "error") ? "error" : "muted";
  const button: CloudRowPresentation["button"] = unsupported && !saved
    ? { label: "Add", kind: "unsupported", disabled: true }
    : savedConnection ? { label: savedConnection.buttonLabel, kind: "saved", disabled: true }
    : { label: input.connecting ? "Adding…" : input.savedWithoutRelay ? "Add route" : "Add", kind: "add", disabled: input.anyConnecting };
  return { statusText, tooltip, dot, ping: savedConnection?.tone === "connecting" || (savedConnection === null && availability === "checking"), statusTone, button };
}

/** The empty-list body: skeleton, the load failure with Try again, or the caller's empty state. */
export function cloudListEmptyState(input: { refreshWhileEmpty: boolean; refreshing: boolean; listedCount: number; offline: boolean; error: string | null }): "skeleton" | { problem: string } | "empty" {
  if (!input.refreshWhileEmpty && input.refreshing && input.listedCount === 0) return "skeleton";
  const problem = input.offline ? "You appear to be offline." : input.error;
  if (problem !== null && !input.refreshing) return { problem };
  return "empty";
}

/** Thrown after a successful relay connect: the step this client cannot take with the credential it got. */
export class RelayRouteUnsupportedError extends Error {
  constructor() {
    super("T3 Connect returned a credential bound to this device's DPoP key, and this client can only open environments with bearer credentials.");
  }
}

export interface ConnectDeps {
  connect: (environmentId: string) => Promise<unknown>;
  /** Saves the environment with its T3 Connect route; the connection manager then opens it with the DPoP credential. */
  save: (input: { relayEnvironmentId: string; label: string; url: string }) => unknown;
}
const defaultDeps: ConnectDeps = { connect: connectRelayEnvironment, save: addRelayEnvironment };

const connectingIds = signal<ReadonlySet<string>>(new Set());

/** connectEnvironment: the toast the reference shows for each outcome; true when added. */
export async function connectCloudEnvironment(environment: { environmentId: string; label: string }, savedWithoutRelay: boolean, deps: ConnectDeps = defaultDeps): Promise<boolean> {
  connectingIds.set(new Set([...connectingIds(), environment.environmentId]));
  let failure: unknown = null;
  try {
    // The relay must accept this device's DPoP key before the route is saved (the connection repeats it per attempt).
    const answer = record(await deps.connect(environment.environmentId));
    const endpoint = record(answer?.endpoint);
    const url = typeof endpoint?.wsBaseUrl === "string" ? endpoint.wsBaseUrl : typeof endpoint?.httpBaseUrl === "string" ? endpoint.httpBaseUrl.replace(/^http/, "ws") : null;
    if (!url) throw new Error("T3 Connect returned no environment endpoint.");
    deps.save({ relayEnvironmentId: environment.environmentId, label: environment.label, url });
  } catch (cause) {
    failure = cause;
  } finally {
    const next = new Set(connectingIds());
    next.delete(environment.environmentId);
    connectingIds.set(next);
  }
  if (failure === null) {
    showToast({
      type: "success",
      title: savedWithoutRelay ? "T3 Connect route added" : "Environment added",
      description: savedWithoutRelay ? `${environment.label} falls back to T3 Connect when its other routes are unreachable.` : `Connecting to ${environment.label} through T3 Connect.`,
    });
    return true;
  }
  const message = failure instanceof Error ? failure.message : "Could not connect the T3 Connect environment.";
  const traceId = failure instanceof RelayDpopError ? failure.traceId : null;
  showToast({
    type: "error",
    title: "Could not connect environment",
    description: message,
    ...(traceId ? { actions: [{ label: "Copy trace ID", variant: "outline" as const, run: () => void Clipboard.writeText(traceId).catch(() => undefined) }] } : {}),
  });
  return false;
}

export const cloudConnectingIds = () => connectingIds();

const DOT_CLASS: Record<CloudRowPresentation["dot"], string> = { success: "bg-success", warning: "bg-warning", destructive: "bg-destructive", muted: "bg-muted-foreground opacity-40" };

function RowsSkeleton() {
  return (
    <View class="flex-row items-center gap-3 px-4 py-3" testID="T3 Connect environments loading">
      <View class="min-w-0 flex-1 gap-2"><View class="h-4 w-32 rounded-full bg-muted" /><View class="h-3 w-20 rounded-full bg-muted" /></View>
      <View class="h-7 w-16 rounded-md bg-muted" />
    </View>
  );
}

export function CloudEnvironmentConnectRows(props: {
  primaryEnvironmentId: string | null;
  savedEnvironments: () => readonly SavedCloudEnvironmentConnection[];
  showSavedEnvironments?: boolean;
  refreshWhileEmpty?: boolean;
  empty?: any;
}) {
  void refreshRelayDiscovery();
  const savedById = () => new Map(props.savedEnvironments().filter((item) => item.relayManaged).map((item) => [item.environmentId, item]));
  const savedWithoutRelay = () => new Set(props.savedEnvironments().filter((item) => !item.relayManaged).map((item) => item.environmentId));
  const visible = () => [...relayDiscovery().environments.values()].filter(({ environment }) =>
    environment.environmentId !== props.primaryEnvironmentId && (props.showSavedEnvironments === true || !savedById().has(environment.environmentId)));
  // Discovery clears its list on refresh, so poll only until a machine appears.
  effect(() => {
    if (!(props.refreshWhileEmpty === true && visible().length === 0 && !relayDiscovery().offline)) return;
    const timer = setInterval(() => { if (!relayDiscovery().refreshing) void refreshRelayDiscovery(); }, EMPTY_DISCOVERY_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  });
  const standalone = () => props.showSavedEnvironments === true || props.savedEnvironments().length === 0;
  return (
    <View testID="T3 Connect environments">
      {standalone() && visible().length === 0 ? (() => {
        const state = cloudListEmptyState({ refreshWhileEmpty: props.refreshWhileEmpty === true, refreshing: relayDiscovery().refreshing, listedCount: relayDiscovery().environments.size, offline: relayDiscovery().offline, error: relayDiscovery().error });
        if (state === "skeleton") return <RowsSkeleton />;
        if (state === "empty") return props.empty ?? null;
        return (
          <View class="px-4 py-3">
            <Text class="text-sm font-medium text-destructive-foreground">Could not load T3 Connect environments</Text>
            <Text class="mt-1 text-xs text-muted-foreground">{state.problem}</Text>
            <View class="mt-3 flex-row"><SettingsButton label="Try again" onPress={() => void refreshRelayDiscovery()} /></View>
          </View>
        );
      })() : visible().map((discovered) => {
        const id = discovered.environment.environmentId;
        const row = presentCloudEnvironmentRow({ discovered, saved: savedById().get(id), savedWithoutRelay: savedWithoutRelay().has(id), connecting: connectingIds().has(id), anyConnecting: connectingIds().size > 0 });
        return (
          <View class="flex-row items-center gap-3 px-4 py-2.5 border-b border-border-50" accessibilityLabel={discovered.environment.label} testID={`cloud-row ${id}`}>
            <View class="min-w-0 flex-1">
              <View class="flex-row items-center gap-2">
                <View tooltip={row.tooltip} class={`size-2 rounded-full ${DOT_CLASS[row.dot]}`} testID={`dot ${row.dot}`} />
                <SettingsIcon name={savedById().get(id)?.machineKind === "desktop" ? "monitor" : "server"} size={16} />
                <Text class="truncate text-sm font-medium text-foreground">{discovered.environment.label}</Text>
              </View>
              <Text class={`mt-1 truncate text-xs ${row.statusTone === "error" ? "text-destructive-foreground" : "text-muted-foreground"}`}>{row.statusText}</Text>
            </View>
            <View tooltip={row.button.kind === "unsupported" ? "Client not supported" : undefined}>
              <SettingsButton label={row.button.label} tone={row.button.kind === "add" ? "primary" : undefined} disabled={row.button.disabled}
                onPress={() => { if (row.button.kind === "add") void connectCloudEnvironment(discovered.environment, savedWithoutRelay().has(id)); }} />
            </View>
          </View>
        );
      })}
    </View>
  );
}

export type { RelayAvailability };
