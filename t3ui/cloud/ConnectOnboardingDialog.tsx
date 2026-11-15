// components/cloud/ConnectOnboardingDialog.tsx + cloud/connectOnboarding.ts: "Set up T3 Connect", opened once per fresh sign-in
// (an observed signed-out -> signed-in change, never for an account already signed in at load), with the Publish step (Publish this
// environment, Publish agent activity) when this session may manage the relay, then Connect devices (CloudEnvironmentConnectRows).
// "Don't show this again" keeps the account in t3code:connect-onboarding-opt-out:v1, apart from the sign-in so sign-out keeps it.
// Mounted beside the other root hosts (routes/__root.tsx appHosts).
import { effect, signal, Storage, Text, View } from "nsh";
import { Dialog, Switch } from "nsh/base";
import { SettingsButton } from "../components/SettingsLayout";
import { showToast } from "../components/toast";
import { WizardSteps } from "../pages/settings/providers/ui";
import { serverManagedPolicy } from "../pages/settings/settingsState";
import { managedCapabilityDenial } from "../pages/settings/managedPolicyLocks";
import { dialogBackdropStyle, dialogPopupMotion, keepPressInDialog } from "../components/dialogSurface";
import { connectAuthState, loadConnectSession } from "./connectSession";
import { hasCloudPublicConfig } from "./publicConfig";
import { managedTunnelUsage } from "./accountState";
import { openAccountPage } from "./AccountPages";
import { T3CHAT_SUBSCRIPTION_URL } from "./relayClient";
import { primaryCloudLink, primaryEnvironmentId, refreshPrimaryCloudLink } from "./primaryCloudLink";
import { primaryEnvironmentScope, primarySessionScopesKnown, RELAY_READ_SCOPE, RELAY_WRITE_SCOPE } from "./t3ConnectState";
import { CloudEnvironmentConnectRows } from "./CloudEnvironmentConnectList";
import { savedEnvironments } from "../pages/settings/environments/savedEnvironments";
import { environmentConnections } from "../environments/connectionManager";
import { openUrl } from "nsh";
import { DialogCloseButton } from "../components/DialogCloseButton";

export const CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY = "t3code:connect-onboarding-opt-out:v1";
export interface ConnectOnboardingOptOutState { optOutAccounts: string[] }
export const EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE: ConnectOnboardingOptOutState = { optOutAccounts: [] };

export function parseOptOutState(raw: unknown): ConnectOnboardingOptOutState {
  if (typeof raw !== "string") return EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value?.optOutAccounts) && value.optOutAccounts.every((item: unknown) => typeof item === "string") ? { optOutAccounts: value.optOutAccounts } : EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE;
  } catch { return EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE; }
}

type OnboardingStep = "publish" | "devices";
const STEP_LABELS: Record<OnboardingStep, string> = { publish: "Publish", devices: "Connect devices" };

export interface OnboardingInputs {
  auth: { isLoaded: boolean; isSignedIn: boolean; userId: string | null };
  optOutAccounts: readonly string[];
  canManageRelay: boolean;
  /** controller.linkState.target !== null: the primary environment is known. */
  hasTarget: boolean;
  sessionScopesKnown: boolean;
}

/** The dialog's render-phase state machine (ConfiguredConnectOnboardingDialog), driven from an effect. */
export function createOnboardingMachine() {
  const s = {
    requestedAccount: signal<string | null>(null),
    openForAccount: signal<string | null>(null),
    step: signal<OnboardingStep>("devices"),
    exposeEnvironment: signal(true),
    publishAgentActivity: signal(true),
    dontShowAgain: signal(false),
    isApplying: signal(false),
    prefilled: signal(false),
    // Start undefined so an existing account never looks like a fresh sign-in.
    observedAccount: signal<string | null | undefined>(undefined),
  };
  const showPublishStep = (input: OnboardingInputs) => input.canManageRelay && input.hasTarget;
  const observe = (input: OnboardingInputs, linkState: { linked: boolean; linkRevoked?: boolean; cloudUserId: string | null; managedTunnelActive?: boolean; publishAgentActivity: boolean } | null) => {
    const { isLoaded, isSignedIn, userId } = input.auth;
    if (s.step() === "publish" && input.sessionScopesKnown && !showPublishStep(input) && !s.isApplying()) s.step.set("devices");
    // A signed-in snapshot without userId is incomplete; recording signed-out would fake a fresh sign-in.
    if (isLoaded && !(isSignedIn && !userId)) {
      const next = isSignedIn && userId ? userId : null;
      const observed = s.observedAccount();
      if (next !== observed) {
        s.observedAccount.set(next);
        if (observed !== undefined && next !== null) s.requestedAccount.set(next);
      }
    }
    if (s.openForAccount() !== null && (!isSignedIn || userId !== s.openForAccount())) s.openForAccount.set(null);
    if (s.requestedAccount() !== null && (!isSignedIn || userId !== s.requestedAccount())) s.requestedAccount.set(null);
    // Wait for the publish target before opening, or the wizard can freeze on devices before publish is available.
    const publishStepDecided = !input.canManageRelay || input.hasTarget;
    const requested = s.requestedAccount();
    if (requested !== null && s.openForAccount() === null) {
      if (input.optOutAccounts.includes(requested)) s.requestedAccount.set(null);
      else if (input.sessionScopesKnown && publishStepDecided) {
        s.requestedAccount.set(null);
        s.prefilled.set(false);
        s.exposeEnvironment.set(true);
        s.publishAgentActivity.set(true);
        s.dontShowAgain.set(false);
        s.step.set(showPublishStep(input) ? "publish" : "devices");
        s.openForAccount.set(requested);
      }
    }
    if (s.openForAccount() !== null && !s.prefilled() && linkState !== null) {
      s.prefilled.set(true);
      if (linkState.linked && linkState.linkRevoked !== true && linkState.cloudUserId === s.openForAccount()) {
        s.exposeEnvironment.set(linkState.managedTunnelActive ?? linkState.linked);
        s.publishAgentActivity.set(linkState.publishAgentActivity);
      }
    }
  };
  /** complete: close, and remember the opt-out when asked. Returns the new opt-out list when it changed. */
  const complete = (optOutAccounts: readonly string[]): string[] | null => {
    if (s.isApplying()) return null;
    const account = s.openForAccount();
    s.openForAccount.set(null);
    if (account !== null && s.dontShowAgain() && !optOutAccounts.includes(account)) return [...optOutAccounts, account];
    return null;
  };
  return { ...s, observe, complete, showPublishStep };
}

const machine = createOnboardingMachine();
const optOut = signal<ConnectOnboardingOptOutState>(EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE);
let optOutLoaded = false;

function inputs(): OnboardingInputs {
  const auth = connectAuthState();
  const canRead = primaryEnvironmentScope(RELAY_READ_SCOPE);
  const canWrite = primaryEnvironmentScope(RELAY_WRITE_SCOPE);
  // A policy that turns Connect off leaves nothing to publish; reaching other devices still works.
  const connectAllowed = managedCapabilityDenial(serverManagedPolicy() as Record<string, unknown> | null, "connect") === undefined;
  return {
    auth: { isLoaded: auth.status !== "loading", isSignedIn: auth.status === "signed-in", userId: auth.status === "signed-in" ? auth.userId : null },
    optOutAccounts: optOut().optOutAccounts,
    canManageRelay: canRead && canWrite && connectAllowed,
    hasTarget: primaryEnvironmentId() !== null,
    sessionScopesKnown: primaryEnvironmentId() === null ? true : primarySessionScopesKnown(),
  };
}

function finish() {
  const next = machine.complete(optOut().optOutAccounts);
  if (next !== null) {
    optOut.set({ optOutAccounts: next });
    void Storage.setItem(CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY, JSON.stringify({ optOutAccounts: next })).catch(() => undefined);
  }
}

async function applyPublishSelection() {
  if (machine.isApplying()) return;
  if (primaryEnvironmentId() === null || !primaryEnvironmentScope(RELAY_READ_SCOPE) || !primaryEnvironmentScope(RELAY_WRITE_SCOPE)) { machine.step.set("devices"); return; }
  if (primaryCloudLink.data() === null || primaryCloudLink.error() !== null) return;
  // Onboarding only enables links; both toggles off must preserve existing links.
  if (!machine.exposeEnvironment() && !machine.publishAgentActivity()) { machine.step.set("devices"); return; }
  machine.isApplying.set(true);
  const ok = await primaryCloudLink.reconcile({ managedTunnel: machine.exposeEnvironment(), publish: machine.publishAgentActivity() });
  machine.isApplying.set(false);
  if (!ok) return;
  showToast({
    type: "success",
    title: "T3 Connect enabled",
    description: machine.exposeEnvironment() ? "This environment is available to your other devices through T3 Connect." : "This environment publishes agent activity to your mobile clients.",
  });
  machine.step.set("devices");
}

function ToggleRow(props: { title: string; description: string; checked: boolean; disabled: boolean; onChange: (next: boolean) => void }) {
  return (
    <View class="flex-row items-start justify-between gap-4 border-t border-border-60 px-4 py-3">
      <View class="min-w-0 flex-1">
        <Text class="text-sm font-medium text-foreground">{props.title}</Text>
        <Text class="mt-1 text-xs text-muted-foreground">{props.description}</Text>
      </View>
      <Switch checked={props.checked} disabled={props.disabled} accessibilityLabel={props.title} testID={`${props.title} ${props.checked ? "on" : "off"}`}
        onChange={(event: { checked?: boolean }) => props.onChange(event.checked === true)}
        class={`h-[18px] w-[30px] items-center ${props.disabled ? "opacity-64" : ""}`} trackClass="h-[18px] w-[30px] justify-center rounded-full bg-input checked:bg-primary transition-colors duration-200 ease-in-out"
        thumbClass="size-3.5 rounded-full bg-background checked:translate-x-3 transition-transform duration-150 ease-in-out" />
    </View>
  );
}

function TunnelLimitAlert() {
  const upgrade = () => managedTunnelUsage().upgrade;
  const leave = (page: "t3-chat" | "t3-connect") => { finish(); openAccountPage(page); };
  return (
    <View class="gap-1 rounded-lg border border-warning bg-warning-4 px-3 py-2">
      <Text class="text-sm font-medium text-foreground">You're out of tunnels (they cost us money).</Text>
      <Text class="text-xs text-muted-foreground">{upgrade() === "link" ? "Switch to Tailscale or get more tunnels by linking your T3 Chat sub (sorry!)"
        : upgrade() ? "Switch to Tailscale or get more tunnels by upgrading your T3 Chat sub (sorry!)" : "Switch to Tailscale or deregister an environment you no longer use (sorry!)"}</Text>
      <View class="flex-row">
        {upgrade() === "link" ? <SettingsButton label="Link T3 Chat" tone="primary" onPress={() => leave("t3-chat")} />
          : upgrade() === "pro" || upgrade() === "premier" ? <SettingsButton label="Upgrade on T3 Chat" tone="primary" onPress={() => void openUrl(T3CHAT_SUBSCRIPTION_URL).catch(() => undefined)} />
          : <SettingsButton label="Manage tunnels" onPress={() => leave("t3-connect")} />}
      </View>
    </View>
  );
}

function PublishStep() {
  const scoped = () => primaryEnvironmentId() !== null && primaryEnvironmentScope(RELAY_READ_SCOPE) && primaryEnvironmentScope(RELAY_WRITE_SCOPE);
  const disabled = () => machine.isApplying() || !inputs().canManageRelay || primaryCloudLink.data() === null;
  const failure = () => primaryCloudLink.operationError() ?? primaryCloudLink.error();
  return (
    <View class="gap-3">
      <View class="overflow-hidden rounded-lg border border-border">
        <ToggleRow title="Publish this environment" description="Make this environment available to your other devices through T3 Connect." checked={machine.exposeEnvironment()} disabled={disabled()} onChange={(next) => { if (scoped()) machine.exposeEnvironment.set(next); }} />
        <ToggleRow title="Publish agent activity" description="Send activity from this environment to your mobile clients for push notifications and Live Activities." checked={machine.publishAgentActivity()} disabled={disabled()} onChange={(next) => { if (scoped()) machine.publishAgentActivity.set(next); }} />
      </View>
      {failure() ? <Text class="text-xs text-destructive-foreground">{failure()}</Text> : null}
      {/maximum of \d+ managed tunnels/u.test(primaryCloudLink.operationError() ?? "") ? <TunnelLimitAlert /> : null}
    </View>
  );
}

function DevicesStep() {
  return (
    <View class="overflow-hidden rounded-lg border border-border">
      <CloudEnvironmentConnectRows
        primaryEnvironmentId={primaryEnvironmentId()}
        savedEnvironments={() => savedEnvironments().map((item) => ({ environmentId: item.relay?.environmentId ?? item.id, relayManaged: item.relay !== undefined, connection: environmentConnections()[item.id] ?? { phase: "available", error: null } }))}
        showSavedEnvironments
        empty={<Text class="px-4 py-6 text-center text-sm text-muted-foreground">No other environments are published to your account yet. Publish one from another device and it will show up here.</Text>}
      />
    </View>
  );
}

const isOpen = () => machine.openForAccount() !== null;

export function ConnectOnboardingDialogHost() {
  if (!hasCloudPublicConfig()) return null;
  void loadConnectSession();
  if (!optOutLoaded) {
    optOutLoaded = true;
    void Storage.getItem(CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY).then((raw) => optOut.set(parseOptOutState(raw)), () => undefined);
  }
  effect(() => {
    if (inputs().canManageRelay && machine.openForAccount() !== null) void refreshPrimaryCloudLink();
  });
  effect(() => machine.observe(inputs(), primaryCloudLink.data()));
  const steps = (): OnboardingStep[] => (machine.showPublishStep(inputs()) ? ["publish", "devices"] : ["devices"]);
  return (
    <Dialog open={isOpen()} animation="fade" onOpenChange={({ open }) => { if (!open && !machine.isApplying()) finish(); }}
      backdropStyle={dialogBackdropStyle()} style={[{ margin: "auto", width: 576, maxWidth: "90%" }, dialogPopupMotion(isOpen)]}>
      <View class="relative gap-4 rounded-2xl border border-border bg-background p-6" onPress={keepPressInDialog} testID="Set up T3 Connect">
        <DialogCloseButton onClose={() => { if (!machine.isApplying()) finish(); }} />
        <View class="gap-1">
          <Text class="text-lg font-semibold text-foreground">Set up T3 Connect</Text>
          <Text class="text-sm text-muted-foreground">Mesh your devices together. Publish this environment and connect the rest, all in one place.</Text>
        </View>
        {steps().length > 1 ? (
          <WizardSteps steps={steps().map((id) => STEP_LABELS[id])} current={steps().indexOf(machine.step())} isDisabled={() => machine.isApplying()}
            onChange={(index) => {
              const next = steps()[index];
              if (next === "publish" && (primaryEnvironmentId() === null || !primaryEnvironmentScope(RELAY_READ_SCOPE) || !primaryEnvironmentScope(RELAY_WRITE_SCOPE))) return;
              if (next) machine.step.set(next);
            }} />
        ) : null}
        {machine.step() === "publish" ? <PublishStep /> : isOpen() ? <DevicesStep /> : null}
        <View class="flex-row items-center gap-2">
          <View role="checkbox" accessibilityLabel="Don't show this again" accessibilityState={{ checked: machine.dontShowAgain() }} onPress={() => machine.dontShowAgain.set(!machine.dontShowAgain())} class="flex-row items-center gap-2">
            <View class={`size-4 items-center justify-center rounded border ${machine.dontShowAgain() ? "border-primary bg-primary" : "border-input bg-background"}`} />
            <Text class="text-xs text-muted-foreground">Don't show this again</Text>
          </View>
          <View class="flex-1" />
          {machine.step() === "publish" ? (
            <>
              <SettingsButton label="Not now" tone="ghost" disabled={machine.isApplying()} onPress={() => machine.step.set("devices")} />
              <SettingsButton label={machine.isApplying() ? "Enabling…" : "Continue"} tone="primary" disabled={machine.isApplying() || !inputs().canManageRelay || primaryCloudLink.data() === null} onPress={() => void applyPublishSelection()} />
            </>
          ) : <SettingsButton label="Done" tone="primary" disabled={machine.isApplying()} onPress={finish} />}
        </View>
      </View>
    </Dialog>
  );
}

/** Tests only. */
export const connectOnboardingMachineForTest = machine;
