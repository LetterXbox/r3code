// SavedEnvironmentRows.tsx CloudLinkRow / ConfiguredCloudLinkRow + cloud/useCloudLinkController.ts: the T3 Connect rows of
// Settings > Access for the connected environment (T3 Connect, Publish agent activity, Hold webhooks while offline),
// driven by cloud/linkEnvironment.ts (the environment's /api/connect/* routes and the relay's link routes). This app is
// the desktop client, so "Turn on" is offered where the environment says its session may link from here.
import { effect, openUrl, signal, Text, View } from "nsh";
import { Switch } from "nsh/base";
import { SettingsButton, SettingsRow } from "../../../components/SettingsLayout";
import { errorToast, showToast } from "../../../components/toast";
import { Tip } from "../providers/ui";
import { connectAuthState } from "../../../cloud/connectSession";
import { openConnectSignIn } from "../../../cloud/ConnectSignIn";
import { hasCloudPublicConfig } from "../../../cloud/publicConfig";
import { managedTunnelUsage, refreshTunnelUsage, relayEnvironments } from "../../../cloud/accountState";
import { openAccountPage, TunnelUsageMeter } from "../../../cloud/AccountPages";
import {
  CloudEnvironmentLinkError, linkEnvironmentToCloud, readCloudLinkState, unlinkEnvironmentFromCloud, updateCloudPreferences, type CloudLinkState,
} from "../../../cloud/linkEnvironment";

type Reachability =
  | { status: "reachable"; checkedAt: string; readyConnections: number | null; protocol: string | null }
  | { status: "unreachable"; checkedAt: string; cause: string; reason: string; hint: string | null; fix: string };
type LinkState = CloudLinkState & { reachability?: Reachability };

/** formatConnectReachable (contracts environmentHttp.ts). */
export function formatConnectReachable(result: Extract<Reachability, { status: "reachable" }>): string {
  const count = result.readyConnections;
  return ["Tunnel connected", ...(count === null ? [] : [`${count} connection${count === 1 ? "" : "s"}`]), ...(result.protocol ? [result.protocol.toUpperCase()] : [])].join(" · ");
}

const REACHABILITY_SECTION: Record<string, string> = {
  not_linked: "sign-in-account-or-link-problems", connector_not_running: "the-hosts-tunnel-is-offline", connector_not_ready: "the-hosts-tunnel-is-offline",
  no_connector: "the-hosts-tunnel-is-offline", edge_unreachable: "port-7844-is-blocked-on-the-host", origin_unreachable: "the-tunnel-works-but-t3-code-does-not-answer",
  unexpected_response: "the-tunnel-works-but-t3-code-does-not-answer", dns_failed: "the-t3-connect-address-does-not-resolve-or-answer", timeout: "the-t3-connect-address-does-not-resolve-or-answer",
};
export const connectReachabilityHelpUrl = (cause: string) =>
  `https://github.com/pingdotgg/t3code/blob/main/docs/user/t3-connect-troubleshooting.md#${REACHABILITY_SECTION[cause] ?? "t3-connect-returned-an-error"}`;

/** isManagedTunnelActive (cloud/t3ConnectState.ts). */
export function isManagedTunnelActive(state: LinkState, relayProviderKind: string | undefined): boolean {
  const local = state.managedTunnelActive ?? state.linked;
  return state.linkRevoked !== true && local && (relayProviderKind === undefined || relayProviderKind === "cloudflare_tunnel");
}

/** The controller (useCloudLinkController) for the connected environment. */
export function createCloudLinkController(environmentId: () => string | null, deps = { readCloudLinkState, linkEnvironmentToCloud, unlinkEnvironmentFromCloud, updateCloudPreferences }) {
  const data = signal<LinkState | null>(null);
  const error = signal<string | null>(null);
  const pending = signal(false);
  const operationError = signal<string | null>(null);
  const refresh = async () => {
    pending.set(true);
    try { data.set((await deps.readCloudLinkState()) as LinkState); error.set(null); }
    catch (cause) { error.set(cause instanceof Error ? cause.message : "Could not read environment cloud link state."); }
    finally { pending.set(false); }
  };
  const providerKind = () => { const id = environmentId(); return id ? relayEnvironments.state().data?.find((item) => item.environmentId === id)?.endpoint.providerKind : undefined; };
  const reportUpdateFailure = (cause: unknown, reason?: string) => {
    const message = cause instanceof Error ? cause.message : "Could not update T3 Connect access.";
    operationError.set(message);
    errorToast("Could not update T3 Connect", reason ?? message);
  };
  const managedTunnelActive = () => (data() ? isManagedTunnelActive(data()!, providerKind()) : false);
  const reconcile = async (desired: { managedTunnel: boolean; publish: boolean; holdWebhooksWhileOffline?: boolean }): Promise<boolean> => {
    operationError.set(null);
    const id = environmentId();
    if (!id) { reportUpdateFailure(new Error("Choose an environment first.")); return false; }
    const wantsLink = desired.managedTunnel || desired.publish;
    const current = data();
    if (wantsLink && current === null) { reportUpdateFailure(new Error("Wait until the current T3 Connect settings can be read.")); return false; }
    try {
      if (!wantsLink) {
        try { await deps.unlinkEnvironmentFromCloud({ environmentId: id }); } catch (cause) {
          const relayKeptLink = cause instanceof CloudEnvironmentLinkError && cause.message.startsWith("Disconnected locally");
          reportUpdateFailure(cause, relayKeptLink ? "Disconnected here, but T3 Connect still lists it. Remove it in Account." : undefined);
          await refresh();
          return false;
        } finally { refreshTunnelUsage(); }
      } else {
        if (!current!.linked || current!.linkRevoked === true || isManagedTunnelActive(current!, providerKind()) !== desired.managedTunnel) {
          try { await deps.linkEnvironmentToCloud({ environmentId: id, mode: desired.managedTunnel ? "managed" : "publish_only" }); }
          catch (cause) { reportUpdateFailure(cause); await refresh(); return false; }
          finally { refreshTunnelUsage(); }
        }
        try {
          await deps.updateCloudPreferences({ publishAgentActivity: desired.publish, ...(desired.holdWebhooksWhileOffline === undefined ? {} : { holdWebhooksWhileOffline: desired.holdWebhooksWhileOffline }) });
        } catch (cause) { reportUpdateFailure(cause); await refresh(); return false; }
      }
      await refresh();
      void relayEnvironments.refresh();
      return true;
    } catch (cause) {
      reportUpdateFailure(cause);
      return false;
    }
  };
  return { data, error, pending, operationError, refresh, managedTunnelActive, reconcile, providerKind };
}

function CloudLinkSwitch(props: { label: string; checked: boolean; disabled: boolean; disabledReason: string | null; onChange: (next: boolean) => void }) {
  const control = (
    <Switch checked={props.checked} disabled={props.disabled} accessibilityLabel={props.label} testID={`${props.label} ${props.checked ? "on" : "off"}`}
      onChange={(event: { checked?: boolean }) => props.onChange(event.checked === true)}
      class={`h-[18px] w-[30px] items-center ${props.disabled ? "opacity-64" : ""}`} trackClass="h-[18px] w-[30px] justify-center rounded-full bg-input checked:bg-primary transition-colors duration-200 ease-in-out"
      thumbClass="size-3.5 rounded-full bg-background checked:translate-x-3 transition-transform duration-150 ease-in-out" />
  );
  return props.disabledReason ? <View tooltip={<Tip label={props.disabledReason} />}>{control}</View> : control;
}

function TunnelUsage() {
  const usage = () => managedTunnelUsage();
  return usage().used !== null && usage().limit !== null ? (
    <View class="gap-1 pb-3">
      <TunnelUsageMeter used={usage().used!} limit={usage().limit!} />
      {usage().upgrade ? <Text class="text-xs font-medium text-foreground underline" onPress={() => openAccountPage("t3-chat")}>Get more tunnels</Text>
        : usage().used! >= usage().limit! ? <Text class="text-xs font-medium text-foreground underline" onPress={() => openAccountPage("t3-connect")}>Manage tunnels</Text> : null}
    </View>
  ) : null;
}

/** CloudLinkRow: nothing without the public config; a permission note without relay:read; else the configured rows. */
export function CloudLinkRow(props: { environmentId: () => string | null; canReadRelay: boolean; canManageRelay: boolean }) {
  if (!hasCloudPublicConfig()) return null;
  if (!props.canReadRelay) return <SettingsRow title="T3 Connect" description="To edit these settings, pair this connection with both View relay and Manage relay permissions." />;
  return <ConfiguredCloudLinkRow environmentId={props.environmentId} canManageRelay={props.canManageRelay} />;
}

function ConfiguredCloudLinkRow(props: { environmentId: () => string | null; canManageRelay: boolean }) {
  const controller = createCloudLinkController(props.environmentId);
  void controller.refresh();
  if (connectAuthState().status === "signed-in") refreshTunnelUsage();
  effect(() => {
    // The server rechecks reachability when the tunnel's 30 s readiness poll changes; poll while mounted.
    const interval = setInterval(() => void controller.refresh(), 30_000);
    return () => clearInterval(interval);
  });
  const updating = signal(false);
  const updatingPreference = signal(false);
  const signedIn = () => connectAuthState().status === "signed-in";
  const signedOut = () => connectAuthState().status === "signed-out";
  const active = () => controller.managedTunnelActive();
  const linkRevoked = () => controller.data()?.linkRevoked ?? false;
  const outOfSync = () => controller.data() !== null && !active() && isManagedTunnelActive(controller.data()!, undefined);
  const publish = () => controller.data()?.publishAgentActivity ?? false;
  const hold = () => controller.data()?.holdWebhooksWhileOffline ?? false;
  const disabledReason = props.canManageRelay ? null : "Your session does not have permission to manage T3 Connect access.";
  const switchDisabled = () => !props.canManageRelay || !signedIn() || controller.data() === null || controller.pending() || updating() || updatingPreference();
  // resolveT3ConnectTurnOn: turning on links from this desktop's own backend only (`linkableHere`); turning off works anywhere.
  const showSwitch = () => controller.data()?.linkableHere === true || active();
  const reachability = () => (active() ? controller.data()?.reachability : undefined);
  const description = () => signedOut()
    ? "Sign in to make this environment available to your other devices through T3 Connect."
    : linkRevoked() ? "This environment was removed from T3 Connect. Turn it on to link it again."
    : active() ? (reachability()?.status === "unreachable" ? "T3 Connect is on, but other devices cannot reach this environment."
      : reachability()?.status === "reachable" ? "This environment is available to your other devices through T3 Connect." : "T3 Connect is on. Reachability has not been checked yet.")
    : outOfSync() ? "T3 Connect is out of sync. This environment is linked only to publish agent activity, so other devices cannot connect. Turn T3 Connect on to repair it."
    : "Make this environment available to your other devices through T3 Connect.";
  const status = () => {
    const failure = controller.operationError() ?? controller.error();
    if (failure) return <Text class="text-xs text-destructive-foreground">{failure}</Text>;
    const result = reachability();
    if (result?.status === "reachable") return <Text class="text-xs text-muted-foreground">{formatConnectReachable(result)}</Text>;
    if (result?.status === "unreachable") return (
      <Text class="text-xs text-destructive-foreground">
        {`${[result.reason, result.hint, `Fix: ${result.fix}`].filter(Boolean).join(" ")} `}
        <Text class="underline" onPress={() => void openUrl(connectReachabilityHelpUrl(result.cause)).catch(() => undefined)}>More info</Text>
      </Text>
    );
    return null;
  };
  const signIn = () => <SettingsButton label="Sign in" onPress={() => void openConnectSignIn()} />;
  const updateManagedTunnel = async (enabled: boolean) => {
    updating.set(true);
    const ok = await controller.reconcile({ managedTunnel: enabled, publish: publish() });
    if (ok) {
      showToast({
        type: "success",
        title: enabled ? "T3 Connect linked" : publish() ? "T3 Connect tunnel disabled" : "T3 Connect unlinked",
        description: enabled ? "This environment is available through T3 Connect."
          : publish() ? "The managed tunnel was removed. Agent activity publishing stays on." : "This environment is no longer available through T3 Connect.",
      });
    }
    updating.set(false);
  };
  const updatePublish = async (enabled: boolean) => {
    updatingPreference.set(true);
    const ok = await controller.reconcile({ managedTunnel: active(), publish: enabled });
    if (ok) showToast({ type: "success", title: enabled ? "Agent activity enabled" : "Agent activity disabled",
      description: enabled ? "This environment publishes agent activity to your mobile clients." : "This environment will stop publishing agent activity." });
    updatingPreference.set(false);
  };
  const updateHold = async (enabled: boolean) => {
    updatingPreference.set(true);
    const ok = await controller.reconcile({ managedTunnel: active(), publish: publish(), holdWebhooksWhileOffline: enabled });
    if (ok) showToast({ type: "success", title: enabled ? "Webhooks held while offline" : "Webhooks no longer held",
      description: enabled ? "T3 Connect keeps webhook requests for up to 24 hours while this environment is offline."
        : "Requests to an offline environment now fail. Anything already held is still delivered." });
    updatingPreference.set(false);
  };
  return (
    <View testID="T3 Connect rows">
      {showSwitch() ? (
        <>
          <View class="h-px bg-border-50" />
          <SettingsRow title="T3 Connect" description={description()} status={status()}
            control={signedOut() ? signIn() : <CloudLinkSwitch label="Enable T3 Connect" checked={active()} disabled={switchDisabled()} disabledReason={disabledReason} onChange={(next) => void updateManagedTunnel(next)} />}>
          </SettingsRow>
          {signedOut() ? null : <View class="px-4"><TunnelUsage /></View>}
        </>
      ) : linkRevoked() ? (
        <><View class="h-px bg-border-50" /><SettingsRow title="T3 Connect" description="This environment was removed from T3 Connect. Run `t3 connect link` on the host to link it again." /></>
      ) : (
        <><View class="h-px bg-border-50" /><SettingsRow title="T3 Connect" description="Run `t3 connect link` on the host, then restart T3 Code there." /></>
      )}
      {signedOut() && showSwitch() ? null : (
        <>
          <View class="h-px bg-border-50" />
          <SettingsRow title="Publish agent activity" description={signedOut() ? "Sign in to send activity to mobile notifications and Live Activities." : "Send activity to mobile notifications and Live Activities without T3 Connect."}
            control={signedOut() ? signIn() : <CloudLinkSwitch label="Publish agent activity to mobile clients" checked={publish()} disabled={switchDisabled()} disabledReason={disabledReason} onChange={(next) => void updatePublish(next)} />} />
        </>
      )}
      {active() && !signedOut() ? (
        <>
          <View class="h-px bg-border-50" />
          <SettingsRow title="Hold webhooks while offline" description="Keep webhook requests for up to 24 hours while this environment is offline, then deliver them. Off: T3 Connect only forwards requests and stores nothing."
            control={<CloudLinkSwitch label="Hold webhook requests while this environment is offline" checked={hold()} disabled={switchDisabled()} disabledReason={disabledReason} onChange={(next) => void updateHold(next)} />} />
        </>
      ) : null}
    </View>
  );
}
