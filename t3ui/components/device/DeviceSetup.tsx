// DeviceSetup.tsx: the "Set up devices" wizard (hub, simulators, agent access) in a dialog.
import { computed, effect, signal, Text, View } from "nsh";
import { SettingsDialog } from "../SettingsDialog";
import { SettingsButton, SettingsSwitch } from "../SettingsLayout";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { fetchSessionGrant, parseSessionGrant, sessionGrantsScope } from "../../backend/providers";
import { backendBearer, backendUrl } from "../../store";
import { deviceHubReadiness, hostUpdateDetail, platformSetupStatus, type DeviceServiceState } from "./deviceLogic";
import { deviceConfigure, deviceList, deviceSetupOpen, type DeviceRequest } from "./deviceState";
import { requestBackend } from "../../store";

const HUB = "Enable this environment to open simulators and emulators, whether they run here or on a remote device host.";
const AGENT = "Allow new agent sessions in this environment to start and control local and remote devices, with required tools set up automatically.";

/** useEnvironmentScope(settings:write): configuring needs it; unknown reads as not granted. */
export const canConfigureDevices = signal(false);
let checkedFor = "";
export function loadConfigureScope() {
  const url = backendUrl(); const bearer = backendBearer();
  if (!url || !bearer || checkedFor === url) return;
  checkedFor = url;
  void fetchSessionGrant(url, bearer).then((raw) => { const s = raw === null ? null : parseSessionGrant(raw); canConfigureDevices.set(s !== null && sessionGrantsScope(s, "settings:write")); }).catch(() => { checkedFor = ""; });
}

export function DeviceSetupBody(props: { state: () => DeviceServiceState; onComplete: () => void; onCancel: () => void; request?: DeviceRequest }) {
  const request = props.request ?? requestBackend;
  const step = signal(0);
  const pending = signal<string | null>(null);
  const message = signal("");
  // `enabled` is a computed boolean, not a plain read of `props.state()`: the device state object is replaced on
  // every subscribeDeviceState push, and reading it directly inside this effect re-fired device.list on each one
  // (the same anti-pattern as DevicePanel.tsx). A computed only changes, and only then re-runs the effect below,
  // when the boolean itself flips.
  const enabled = computed(() => props.state().hostStatus !== "disabled");
  const readiness = () => deviceHubReadiness(props.state());
  effect(() => { loadConfigureScope(); });
  effect(() => { if (enabled()) void deviceList({}, request).catch(() => {}); });
  async function update(kind: string, input: { enabled?: boolean; agentAccessEnabled?: boolean; onboardingCompleted?: boolean }) {
    if (!canConfigureDevices()) return;
    pending.set(kind); message.set("");
    try { await deviceConfigure(input, request); if (kind === "complete") props.onComplete(); }
    catch (cause) { message.set(cause instanceof Error ? cause.message : "Could not save."); }
    finally { pending.set(null); }
  }
  const steps = ["Device hub", "Simulators", "Agent access"];
  const retryingHost = signal<string | null>(null);
  // AgentDeviceSetupStatus: progress while agent access is saved, then "Agent tools are ready." once a host has them.
  const agentStatus = (): string | null => {
    const state = props.state();
    if (pending() === "agent") return state.hostStatus === "installing" ? "Installing agent tools…" : state.hostStatus === "starting" ? "Starting agent tools…" : "Updating agent access…";
    return state.agentAccessEnabled && readiness().ready && state.hosts.some((host) => host.agentDeviceInstalled) ? "Agent tools are ready." : null;
  };
  const busy = () => readiness().busy || pending() !== null;
  return (
    <View class="gap-4">
      <View class="flex-row gap-2">{steps.map((name, index) => <Text class={`text-xs ${index === step() ? "font-medium text-foreground" : "text-muted-foreground"}`}>{`${index + 1}. ${name}`}</Text>)}</View>
      {props.state().hosts.map((host) => {
        const status = props.state().hostStatuses[host.id];
        if (!status || !["installing", "starting", "failed"].includes(status.status)) return null;
        const failed = status.status === "failed";
        // DeviceHostUpdates: a failed host says what to check, and retries itself where the server supports it.
        return (
          <View {...(failed ? { role: "alert" as const } : {})} class="flex-row items-start gap-3 rounded-md border border-border-60 px-3 py-2">
            <View class="min-w-0 flex-1">
              <Text class="text-xs font-medium text-foreground">{host.label}</Text>
              <Text class="text-xs text-muted-foreground">{hostUpdateDetail(status)}</Text>
              {failed ? <Text class="mt-1 text-xs text-muted-foreground">Check the host connection and network access, then retry. Your device settings are saved.</Text> : null}
            </View>
            {failed && props.state().supportsHostRetry ? (
              <SettingsButton label={retryingHost() === host.id ? "Retrying…" : "Retry"} accessibilityLabel={`Retry ${host.label}`} disabled={retryingHost() !== null} onPress={() => { retryingHost.set(host.id); void deviceList({ retryHostId: host.id }, request).catch(() => {}).finally(() => retryingHost.set(null)); }} />
            ) : null}
          </View>
        );
      })}
      {step() === 0 ? (
        <View class="gap-3">
          <Text class="text-sm font-medium text-foreground">Enable the device hub</Text>
          <View class="flex-row items-start justify-between gap-4"><Text class="min-w-0 flex-1 text-sm text-muted-foreground">{HUB}</Text>
            <SettingsSwitch label="Enable device hub" checked={enabled()} onChange={(next) => { if (canConfigureDevices() && !busy()) void update("hub", { enabled: next, ...(next ? {} : { agentAccessEnabled: false }) }); }} /></View>
          {readiness().ready ? <Text class="text-xs text-muted-foreground">Device hub is ready.</Text> : pending() === "hub" || readiness().busy ? <Text class="text-xs text-muted-foreground">{props.state().hostStatus === "installing" ? "Installing device hub…" : props.state().hostStatus === "starting" ? "Starting device hub…" : "Updating device hub…"}</Text> : null}
        </View>
      ) : null}
      {step() === 1 ? (
        <View class="gap-3">
          <Text class="text-sm font-medium text-foreground">Check simulator support</Text>
          {(["ios", "android"] as const).map((platform) => { const status = platformSetupStatus(props.state(), platform); return <View class="rounded-md border border-border-60 px-3 py-2"><Text class="text-sm font-medium text-foreground">{platform === "ios" ? "iOS" : "Android"}</Text><Text class="text-xs text-muted-foreground">{status.message}</Text></View>; })}
          <Text class="text-xs text-muted-foreground">You can use either platform. Fixing a missing platform does not block the other one.</Text>
          <SettingsButton label={pending() === "check" ? "Checking…" : "Check again"} accessibilityLabel="Check again" disabled={!enabled() || busy()} onPress={() => { pending.set("check"); void deviceList({}, request).catch(() => {}).finally(() => pending.set(null)); }} />
        </View>
      ) : null}
      {step() === 2 ? (
        <View class="gap-3">
          <Text class="text-sm font-medium text-foreground">Allow agent control</Text>
          <View class="flex-row items-start justify-between gap-4"><Text class="min-w-0 flex-1 text-sm text-muted-foreground">{AGENT}</Text>
            <SettingsSwitch label="Allow agents to control devices" checked={props.state().agentAccessEnabled} onChange={(next) => { if (canConfigureDevices() && enabled() && !busy()) void update("agent", { agentAccessEnabled: next }); }} /></View>
          {agentStatus() ? <Text class="text-xs text-muted-foreground">{agentStatus()}</Text> : null}
          <Text class="text-xs text-muted-foreground">Leave this off to keep manual device controls without giving agents access.</Text>
        </View>
      ) : null}
      {props.state().hostStatus === "failed" && props.state().hostStatusDetail ? <Text class="text-xs text-destructive-foreground" role="alert">{props.state().hostStatusDetail}</Text> : null}
      {message() ? <Text class="text-xs text-destructive-foreground" role="alert">{message()}</Text> : null}
      <View class="flex-row justify-end gap-2">
        {step() === 0 ? <SettingsButton label="Cancel" onPress={props.onCancel} /> : <SettingsButton label="Back" disabled={busy()} onPress={() => step.set(step() - 1)} />}
        {step() < 2 ? <SettingsButton tone="primary" label="Continue" disabled={!readiness().ready || pending() !== null} onPress={() => step.set(step() + 1)} />
          : <SettingsButton tone="primary" label={pending() === "complete" ? "Saving…" : "Done"} disabled={!canConfigureDevices() || !readiness().ready || pending() !== null} onPress={() => void update("complete", { onboardingCompleted: true })} />}
      </View>
    </View>
  );
}

export function DeviceSetupDialog(props: { open: () => boolean; state: () => DeviceServiceState; onClose: () => void; request?: DeviceRequest }) {
  useOverlayOpen(() => props.open(), "device setup");
  return (
    <SettingsDialog open={props.open()} onClose={props.onClose} title="Set up devices" description="Review what runs on this environment before using simulators and emulators." width={560}>
      {props.open() ? <DeviceSetupBody state={props.state} onComplete={props.onClose} onCancel={props.onClose} {...(props.request ? { request: props.request } : {})} /> : null}
    </SettingsDialog>
  );
}

/** The launcher's setup dialog (openDeviceSetupDialog): mounted once by the right panel. */
export function DeviceSetupHost(props: { state: () => DeviceServiceState; request?: DeviceRequest }) {
  return <DeviceSetupDialog open={() => deviceSetupOpen()} state={props.state} onClose={() => deviceSetupOpen.set(false)} {...(props.request ? { request: props.request } : {})} />;
}
