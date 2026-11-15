// ConnectionsSettings.tsx renderNetworkAccessRow / renderEndpointRows / renderTailscaleRow and their dialogs, for the
// environment this launcher runs (desktop/networkAccess.ts). Turning Network access on or off, and Tailscale HTTPS,
// restart the local server and this window, as the reference relaunches the app.
import { effect, signal, Storage, Text, View } from "nsh";
import { SettingsButton, SettingsRow, SettingsSwitch } from "../components/SettingsLayout";
import { DialogField, SettingsDialog } from "../components/SettingsDialog";
import { DialogInput } from "../components/DialogInput";
import { showToast } from "../components/toast/toastState";
import {
  endpointDefaultPreferenceKey, isTailscaleHttpsEndpoint, missingTailscaleEndpointDescription, resolveTailscaleServeBaseUrl,
  selectPairingEndpoint, type AdvertisedEndpoint,
} from "../pages/settings/environments/connectionsLogic";
import { networkAccess, type ServerExposureMode } from "./networkAccess";

const DEFAULT_TAILSCALE_SERVE_PORT = 443;
const DEFAULT_ENDPOINT_KEY = "desktop_default_advertised_endpoint";

export const networkAccessAvailable = () => networkAccess() !== null;

export function NetworkAccessRows(props: { remoteClientsDenial?: string }) {
  const bridge = networkAccess();
  if (!bridge) return null;
  const pendingMode = signal<ServerExposureMode | null>(null);
  const updating = signal(false);
  const mutationError = signal<string | null>(null);
  const expanded = signal(false);
  const defaultKey = signal<string | null>(null);
  const pendingTailscale = signal<AdvertisedEndpoint | null>(null);
  const portInput = signal(String(DEFAULT_TAILSCALE_SERVE_PORT));
  const disableTailscaleOpen = signal(false);
  const updatingTailscale = signal(false);
  effect(() => { void bridge.refresh(); void Storage.getItem(DEFAULT_ENDPOINT_KEY).then((v) => defaultKey.set(v)).catch(() => undefined); });

  const state = () => bridge.snapshot()?.serverExposureState ?? null;
  const endpoints = () => bridge.snapshot()?.advertisedEndpoints ?? [];
  const accessible = () => state()?.mode === "network-accessible";
  const tailscaleHttps = () => endpoints().find(isTailscaleHttpsEndpoint) ?? null;
  const networkEndpoints = () => (accessible() ? endpoints().filter((e) => !isTailscaleHttpsEndpoint(e)) : []);
  const defaultEndpoint = () => selectPairingEndpoint(networkEndpoints(), defaultKey());
  const hiddenCount = () => Math.max(networkEndpoints().length - 1, 0);
  const portText = () => portInput().trim();
  const port = () => Number(portText());
  const portValid = () => /^\d+$/u.test(portText()) && Number.isInteger(port()) && port() >= 1 && port() <= 65_535;

  const changeMode = async () => {
    const mode = pendingMode();
    if (mode === null) return;
    updating.set(true);
    mutationError.set(null);
    try {
      await bridge.setServerExposureMode(mode);
      pendingMode.set(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update network exposure.";
      pendingMode.set(null);
      mutationError.set(message);
      showToast({ type: "error", title: "Could not update network access", description: message });
    }
    updating.set(false);
  };
  const setupTailscale = async () => {
    const endpoint = pendingTailscale();
    if (!endpoint || !portValid()) return;
    updatingTailscale.set(true);
    mutationError.set(null);
    try {
      await bridge.setTailscaleServeEnabled({ enabled: true, port: port() });
      pendingTailscale.set(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to configure Tailscale HTTPS.";
      mutationError.set(message);
      showToast({ type: "error", title: "Could not set up Tailscale HTTPS", description: message });
    }
    updatingTailscale.set(false);
  };
  const disableTailscale = async () => {
    updatingTailscale.set(true);
    mutationError.set(null);
    try {
      await bridge.setTailscaleServeEnabled({ enabled: false, port: state()?.tailscaleServePort ?? DEFAULT_TAILSCALE_SERVE_PORT });
      disableTailscaleOpen.set(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to disable Tailscale HTTPS.";
      mutationError.set(message);
      showToast({ type: "error", title: "Could not disable Tailscale HTTPS", description: message });
    }
    updatingTailscale.set(false);
  };
  const startSetup = (endpoint: AdvertisedEndpoint) => { portInput.set(String(state()?.tailscaleServePort ?? DEFAULT_TAILSCALE_SERVE_PORT)); pendingTailscale.set(endpoint); };
  const setDefault = (endpoint: AdvertisedEndpoint) => { const key = endpointDefaultPreferenceKey(endpoint); defaultKey.set(key); void Storage.setItem(DEFAULT_ENDPOINT_KEY, key).catch(() => undefined); };

  const description = () => {
    if (!state()) return "Loading…";
    if (!accessible()) return "Limited to this machine.";
    const endpoint = defaultEndpoint();
    if (endpoint) return `Reachable at ${endpoint.httpBaseUrl}`;
    const s = state()!;
    return s.endpointUrl ? `Reachable at ${s.endpointUrl}` : s.advertisedHost ? `Exposed on all interfaces. Pairing links use ${s.advertisedHost}.` : "Exposed on all interfaces.";
  };

  const EndpointRow = (rowProps: { endpoint: AdvertisedEndpoint }) => {
    const endpoint = rowProps.endpoint;
    const available = endpoint.status === "available";
    const needsSetup = isTailscaleHttpsEndpoint(endpoint) && !available;
    const canDisable = isTailscaleHttpsEndpoint(endpoint) && available;
    const isDefault = endpointDefaultPreferenceKey(endpoint) === (defaultEndpoint() ? endpointDefaultPreferenceKey(defaultEndpoint()!) : null);
    return (
      <View class={`relative px-4 py-3 ${available ? "" : "bg-muted-10"}`}>
        {isDefault ? <View class="absolute bottom-2 left-0 top-2 w-1 rounded-r-full bg-primary" /> : null}
        <View class="min-h-7 flex-row items-center gap-3">
          <View class="min-w-0 flex-1 flex-row items-center gap-3">
            <Text class="shrink-0 text-sm font-medium leading-5 text-foreground">{endpoint.label}</Text>
            {needsSetup ? null : <Text class="min-w-0 truncate text-xs leading-5 text-muted-foreground">{endpoint.httpBaseUrl}</Text>}
            {available ? null : <View class="h-6 shrink-0 items-center justify-center rounded-md border border-border-70 px-1.5"><Text class="text-3xs text-muted-foreground">Setup required</Text></View>}
          </View>
          <View class="ml-auto shrink-0 flex-row items-center justify-end gap-2">
            {isDefault ? <View class="h-6 items-center justify-center rounded-md border border-primary px-1.5"><Text class="text-3xs text-primary">Default</Text></View> : null}
            {needsSetup ? <SettingsButton label={updatingTailscale() ? "Restarting…" : "Setup"} disabled={updatingTailscale() || props.remoteClientsDenial !== undefined} onPress={() => startSetup(endpoint)} /> : null}
            {canDisable ? <SettingsButton tone="destructive" label={updatingTailscale() ? "Restarting…" : "Disable"} disabled={updatingTailscale()} onPress={() => disableTailscaleOpen.set(true)} /> : null}
            {!needsSetup && !isDefault ? <SettingsButton label="Set as default" onPress={() => setDefault(endpoint)} /> : null}
          </View>
        </View>
      </View>
    );
  };

  return () => (
    <>
      <View class="h-px bg-border-50" />
      <SettingsRow
        title="Network access"
        description={description()}
        status={
          mutationError() ?? bridge.error()
            ? <Text class="text-xs text-destructive">{mutationError() ?? bridge.error()}</Text>
            : accessible() && hiddenCount() > 0
              ? <View role="button" accessibilityLabel={expanded() ? "Hide endpoints" : `Show ${hiddenCount()} more endpoints`} onPress={() => expanded.set(!expanded())}><Text class="text-xs font-medium text-muted-foreground hover:text-foreground">{expanded() ? "Hide" : `+${hiddenCount()}`}</Text></View>
              : null
        }
        control={<View class={!state() || updating() ? "opacity-50" : ""} style={!state() || updating() ? { pointerEvents: "none" } : undefined}>
          <SettingsSwitch label="Enable network access" checked={accessible()} onChange={(checked) => pendingMode.set(checked ? "network-accessible" : "local-only")} />
        </View>}
      />
      {expanded() ? networkEndpoints().map((endpoint) => <EndpointRow endpoint={endpoint} />) : null}
      <View class="h-px bg-border-50" />
      <SettingsRow
        title="Tailscale HTTPS"
        description={tailscaleHttps() ? (tailscaleHttps()!.status === "available" ? tailscaleHttps()!.httpBaseUrl : "Use Tailscale Serve to expose this backend through a MagicDNS HTTPS URL.") : missingTailscaleEndpointDescription(state())}
        control={tailscaleHttps() ? <View class={updatingTailscale() ? "opacity-50" : ""} style={updatingTailscale() ? { pointerEvents: "none" } : undefined}>
          <SettingsSwitch label="Enable Tailscale HTTPS" checked={tailscaleHttps()!.status === "available"} onChange={(checked) => { if (checked) startSetup(tailscaleHttps()!); else disableTailscaleOpen.set(true); }} />
        </View> : null}
      />
      <SettingsDialog
        open={pendingMode() !== null}
        width={448}
        onClose={() => { if (!updating()) pendingMode.set(null); }}
        title={pendingMode() === "network-accessible" ? "Enable network access?" : "Disable network access?"}
        description={pendingMode() === "network-accessible"
          ? "Let your other devices connect to T3 Code over the network. Pair devices to give them access. T3 Code will restart."
          : "Devices connected over your local network will disconnect. Existing tunnels, such as T3 Connect or Tailscale HTTPS, keep working. T3 Code will restart."}
        footer={<>
          <SettingsButton label="Cancel" disabled={updating()} onPress={() => pendingMode.set(null)} />
          <SettingsButton tone="primary" disabled={updating() || pendingMode() === null} label={updating() ? "Restarting…" : pendingMode() === "network-accessible" ? "Restart and enable" : "Restart and disable"} onPress={() => void changeMode()} />
        </>}
      />
      <SettingsDialog
        open={pendingTailscale() !== null}
        width={448}
        onClose={() => { if (!updatingTailscale()) pendingTailscale.set(null); }}
        title="Set up Tailscale HTTPS?"
        description="T3 Code will restart the local backend with Tailscale Serve enabled and ask Tailscale to proxy HTTPS traffic to this backend."
        footer={<>
          <SettingsButton label="Cancel" disabled={updatingTailscale()} onPress={() => pendingTailscale.set(null)} />
          <SettingsButton tone="primary" disabled={updatingTailscale() || !portValid()} label={updatingTailscale() ? "Restarting…" : "Enable"} onPress={() => void setupTailscale()} />
        </>}
      >
        <View class="gap-3">
          <DialogField label="HTTPS port">
            <DialogInput accessibilityLabel="HTTPS port" keyboardType="number-pad" disabled={updatingTailscale()} value={portInput()} onChange={(event: { value: string }) => portInput.set(event.value)} class="h-8 rounded-lg border border-input bg-background px-3 text-sm text-foreground" />
          </DialogField>
          {portValid() ? null : <Text class="text-xs text-destructive">Enter a port from 1 to 65535.</Text>}
          <View class="rounded-md border border-border-70 bg-muted-10 px-3 py-2">
            <Text class="text-xs font-medium text-muted-foreground">HTTPS endpoint</Text>
            <Text class="mt-1 truncate text-sm text-foreground">{resolveTailscaleServeBaseUrl(pendingTailscale(), port(), portValid()) ?? "Pending MagicDNS endpoint"}</Text>
          </View>
        </View>
      </SettingsDialog>
      <SettingsDialog
        open={disableTailscaleOpen()}
        width={448}
        onClose={() => { if (!updatingTailscale()) disableTailscaleOpen.set(false); }}
        title="Disable Tailscale HTTPS?"
        description="T3 Code will restart the local backend without Tailscale Serve."
        footer={<>
          <SettingsButton label="Cancel" disabled={updatingTailscale()} onPress={() => disableTailscaleOpen.set(false)} />
          <SettingsButton tone="destructive" disabled={updatingTailscale()} label={updatingTailscale() ? "Restarting…" : "Restart and disable"} onPress={() => void disableTailscale()} />
        </>}
      />
    </>
  );
}
