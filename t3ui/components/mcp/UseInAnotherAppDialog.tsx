// UseInAnotherAppDialogHost / UseInAnotherAppDialog / Wizard / useGate / useGrantableLevels (components/mcp/UseInAnotherAppDialog.tsx):
// the "Use T3 Code in another app (MCP)" wizard for the environment this app is connected to (the primary, so `thisMachine`). The
// gate (mcpGate.ts) reads the T3 Connect sign-in, the environment's link state and a reachability check it runs; once open, the
// App / Access / Connect steps (McpWizard.tsx) mint a one-use approval code with POST /api/auth/pairing-token.
import { effect, signal, Text, View } from "nsh";
import { Dialog } from "nsh/base";
import { backendBearer, backendStatus, backendUrl, openSettings } from "../../store";
import { serverEnvironment, serverManagedPolicy } from "../../pages/settings/settingsState";
import { managedCapabilityDenial, managedRuntimeModeDenial } from "../../pages/settings/managedPolicyLocks";
import { accessSession } from "../../pages/settings/environments/accessSession";
import { SettingsButton } from "../SettingsLayout";
import { WizardSteps } from "../../pages/settings/providers/ui";
import { connectAuthState } from "../../cloud/connectSession";
import { openConnectSignIn } from "../../cloud/ConnectSignIn";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { relayEnvironments } from "../../cloud/accountState";
import { openAccountPage } from "../../cloud/AccountPages";
import { checkCloudReachability, httpBaseOf, readCloudLinkState } from "../../cloud/linkEnvironment";
import { primaryCloudLink, refreshPrimaryCloudLink } from "../../cloud/primaryCloudLink";
import { ACCESS_WRITE_SCOPE, primaryEnvironmentScope, RELAY_READ_SCOPE, RELAY_WRITE_SCOPE, resolveT3ConnectTurnOn } from "../../cloud/t3ConnectState";
import { closeUseInAnotherApp, mcpGateTitle, useInAnotherAppOpen } from "./useInAnotherAppState";
import { dialogBackdropStyle, dialogPopupMotion, keepPressInDialog } from "../dialogSurface";
import { afterFailedCheck, isManagedTunnelActive, resolveMcpGate, type EnvironmentCloudLinkStateResult, type EnvironmentConnectReachability, type McpGate } from "./mcpGate";
import { DEFAULT_MCP_LEVELS, MCP_ACCESS_LEVELS, MCP_WIZARD_STEPS, McpAccessStep, McpAppStep, McpConnectStep, McpGateScreen, type McpApprovalCode, type McpChoice, type McpClientAccess, type McpWizardStep } from "./McpWizard";
import { DialogCloseButton } from "../DialogCloseButton";

export const MCP_APPROVAL_CODE_LABEL = "App sign-in";

/** mcpClientScopes (contracts auth.ts). */
export function mcpClientScopes(access: McpClientAccess): string[] {
  return access === "read-only" ? ["orchestration:read"]
    : access === "full-access" ? ["orchestration:read", "orchestration:operate", "settings:write", "source-control:write"]
    : ["orchestration:read", "orchestration:operate"];
}

/** useGrantableLevels: why each level cannot be granted on this environment; absent when it can. */
export function grantableLevelDenials(input: { label: string; canMint: boolean; sessionScopes: readonly string[] | null; policy: Record<string, unknown> | null }): Map<McpClientAccess, string> {
  const remoteDenial = managedCapabilityDenial(input.policy, "remoteClients");
  const denials = new Map<McpClientAccess, string>();
  for (const level of MCP_ACCESS_LEVELS) {
    const reason = remoteDenial ?? (!input.canMint
      ? `This device needs the Manage access permission on ${input.label}.`
      : input.sessionScopes === null || !mcpClientScopes(level).every((scope) => input.sessionScopes!.includes(scope))
        ? `This device cannot grant this on ${input.label}.`
        : level === "read-only" ? undefined : managedRuntimeModeDenial(input.policy, level));
    if (reason !== undefined) denials.set(level, reason);
  }
  return denials;
}

type CheckState = "idle" | "running" | { result: EnvironmentConnectReachability | null; since: string | null };

/** useGate's reachability argument: a newer server check counts after a run of ours. */
export function gateReachability(check: CheckState, reported: EnvironmentConnectReachability | undefined): EnvironmentConnectReachability | "checking" | null {
  if (typeof check === "string") return "checking";
  return reported !== undefined && check.since !== null && reported.checkedAt > check.since ? reported : check.result;
}

/** mintMcpApprovalCode: a hidden code that approves one app's sign-in at `access`. */
export async function mintMcpApprovalCode(access: McpClientAccess, fetcher: typeof fetch = fetch): Promise<McpApprovalCode> {
  const socketUrl = backendUrl();
  const bearer = backendBearer();
  if (!socketUrl || !bearer) throw new Error("The environment is not connected.");
  const response = await fetcher(`${httpBaseOf(socketUrl)}/api/auth/pairing-token`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ label: MCP_APPROVAL_CODE_LABEL, access }),
  });
  if (!response.ok) throw new Error(`Request failed (HTTP ${response.status})`);
  const json = (await response.json()) as Record<string, unknown>;
  if (typeof json.credential !== "string") throw new Error("The environment returned no code.");
  return { credential: json.credential, expiresAt: Date.parse(String(json.expiresAt)) || Date.now() + 120_000 };
}

const step = signal<McpWizardStep>(0);
const choice = signal<McpChoice | null>(null);
const picked = signal<McpClientAccess | null>(null);
const check = signal<CheckState>("idle");
const connecting = signal(false);
const now = signal(Date.now());

function resetWizard() {
  step.set(0); choice.set(null); picked.set(null); check.set("idle"); connecting.set(false);
}

const environmentLabel = () => (backendStatus() === "connected" ? ((serverEnvironment()?.label as string | undefined) ?? "R3 Code") : null);
const signedIn = (): boolean | undefined => { const status = connectAuthState().status; return status === "loading" ? undefined : status === "signed-in"; };

function currentGate(): McpGate {
  const environment = serverEnvironment();
  const capabilities = (environment?.capabilities ?? null) as Record<string, unknown> | null;
  const linkState = primaryCloudLink.data() as EnvironmentCloudLinkStateResult | null;
  const relayState = relayEnvironments.state();
  const id = typeof environment?.environmentId === "string" ? environment.environmentId : null;
  return resolveMcpGate({
    signedIn: signedIn(),
    connected: backendStatus() === "connected",
    approvalCodes: environment === null ? undefined : capabilities?.mcpApprovalCodes === true,
    canReadRelay: primaryEnvironmentScope(RELAY_READ_SCOPE),
    linkState,
    linkStateError: primaryCloudLink.error(),
    thisMachine: true,
    relay: relayState.error !== null && !relayState.pending ? { status: "failed" }
      : relayState.data !== null ? { status: "listed", endpoint: relayState.data.find((item) => item.environmentId === id)?.endpoint } : { status: "loading" },
    reachability: gateReachability(check(), linkState?.reachability),
  });
}

async function runReachabilityCheck() {
  check.set("running");
  const prior = primaryCloudLink.data() as EnvironmentCloudLinkStateResult | null;
  try {
    const result = (await checkCloudReachability()) as EnvironmentConnectReachability;
    void refreshPrimaryCloudLink();
    check.set({ result, since: result.checkedAt });
  } catch {
    void refreshPrimaryCloudLink();
    const latest = (await readCloudLinkState().catch(() => null)) as EnvironmentCloudLinkStateResult | null;
    check.set(afterFailedCheck(prior, latest));
  }
}

async function turnOn() {
  connecting.set(true);
  const ok = await primaryCloudLink.reconcile({ managedTunnel: true, publish: primaryCloudLink.data()?.publishAgentActivity ?? false });
  if (!ok) connecting.set(false);
}

function Wizard(props: { label: string }) {
  resetWizard();
  void refreshPrimaryCloudLink();
  if (connectAuthState().status === "signed-in") void relayEnvironments.refresh();
  effect(() => {
    // The server has no push for link state while its tunnel starts; poll while waiting.
    const gate = currentGate();
    if (!(gate.kind === "offline" || (connecting() && gate.kind === "turn-on"))) return;
    const interval = setInterval(() => void refreshPrimaryCloudLink(), 5_000);
    return () => clearInterval(interval);
  });
  effect(() => {
    if (!connecting()) return;
    const timeout = setTimeout(() => connecting.set(false), 90_000);
    return () => clearTimeout(timeout);
  });
  effect(() => {
    // A cached link state can name a tunnel on a disconnected machine; check only a connected one, once.
    const linkState = primaryCloudLink.data() as EnvironmentCloudLinkStateResult | null;
    if (backendStatus() === "connected" && linkState !== null && isManagedTunnelActive(linkState, undefined) && check() === "idle") queueMicrotask(() => { if (check() === "idle") void runReachabilityCheck(); });
  });
  effect(() => {
    const interval = setInterval(() => now.set(Date.now()), 1000);
    return () => clearInterval(interval);
  });
  const levels = () => grantableLevelDenials({
    label: props.label,
    canMint: primaryEnvironmentScope(ACCESS_WRITE_SCOPE),
    sessionScopes: accessSession().status === "ready" ? accessSession().scopes : null,
    policy: serverManagedPolicy() as Record<string, unknown> | null,
  });
  const access = () => picked() ?? DEFAULT_MCP_LEVELS.find((level) => !levels().has(level)) ?? null;
  const appName = () => (choice() === null || choice() === "other" ? "the app" : (choice() as { name: string }).name);
  const turnOnHere = () => resolveT3ConnectTurnOn({
    desktopApp: true,
    linkableHere: primaryCloudLink.data()?.linkableHere === true,
    cloudConfigured: hasCloudPublicConfig(),
    canReadRelay: primaryEnvironmentScope(RELAY_READ_SCOPE),
    canWriteRelay: primaryEnvironmentScope(RELAY_WRITE_SCOPE),
    connectDenial: managedCapabilityDenial(serverManagedPolicy() as Record<string, unknown> | null, "connect"),
  });
  const actions = () => ({
    signIn: () => { closeUseInAnotherApp(); void openConnectSignIn(); },
    checkAgain: () => void runReachabilityCheck(),
    refreshList: () => void relayEnvironments.refresh(),
    turnOn: () => void turnOn(),
    connecting: connecting() && currentGate().kind !== "open",
    operationError: primaryCloudLink.operationError(),
    tunnelLimit: /maximum of \d+ managed tunnels/u.test(primaryCloudLink.operationError() ?? ""),
    turnOnHere: turnOnHere(),
    manageAccess: () => { closeUseInAnotherApp(); openAccountPage("t3-connect"); },
  });
  return (
    <View class="gap-4">
      {currentGate().kind === "open" ? (
        <WizardSteps steps={MCP_WIZARD_STEPS} current={step()} isDisabled={(index) => index > step()} onChange={(index) => step.set(index as McpWizardStep)} />
      ) : null}
      {(() => {
        const gate = currentGate();
        if (gate.kind !== "open") return <McpGateScreen name={props.label} gate={gate} actions={actions()} />;
        if (step() === 0) return <McpAppStep choice={choice()} onChoose={(next) => choice.set(next)} />;
        if (step() === 1) return <McpAccessStep appName={appName()} access={access()} denials={levels()} onPick={(level) => picked.set(level)} />;
        return choice() !== null && access() !== null
          ? <McpConnectStep environmentName={props.label} mcpUrl={gate.mcpUrl} choice={choice()!} access={access()!} mint={(level) => mintMcpApprovalCode(level)} now={() => now()} />
          : null;
      })()}
      {currentGate().kind === "open" ? (
        <View class="flex-row items-center gap-2">
          {step() === 2 ? <SettingsButton label="Manage access" tone="ghost" onPress={() => { closeUseInAnotherApp(); openSettings("/settings/access"); }} /> : null}
          <View class="flex-1" />
          {step() === 1 ? <SettingsButton label="Back" onPress={() => step.set(0)} /> : null}
          {step() === 2
            ? <SettingsButton label="Done" tone="primary" onPress={closeUseInAnotherApp} />
            : <SettingsButton label="Next" tone="primary" disabled={step() === 0 ? choice() === null : access() === null} onPress={() => step.set(step() === 0 ? 1 : 2)} />}
        </View>
      ) : null}
    </View>
  );
}

export function UseInAnotherAppDialogHost() {
  const title = () => mcpGateTitle(environmentLabel());
  return (
    <Dialog
      open={useInAnotherAppOpen()}
      animation="fade"
      onOpenChange={({ open }) => { if (!open) closeUseInAnotherApp(); }}
      backdropStyle={dialogBackdropStyle()}
      style={[{ margin: "auto", width: 576, maxWidth: "90%" }, dialogPopupMotion(useInAnotherAppOpen)]}
    >
      <View class="relative gap-4 rounded-2xl border border-border bg-background p-6" onPress={keepPressInDialog}>
        <DialogCloseButton onClose={closeUseInAnotherApp} />
        <Text class="text-lg font-semibold text-foreground">{title().title}</Text>
        {useInAnotherAppOpen() && environmentLabel() !== null && hasCloudPublicConfig()
          ? <Wizard label={environmentLabel()!} />
          : <Text class="text-base font-medium text-foreground">{title().message}</Text>}
      </View>
    </Dialog>
  );
}
