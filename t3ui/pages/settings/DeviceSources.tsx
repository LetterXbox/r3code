// DeviceSourcesSettings.tsx with the host editors (DeviceHostEditor, EasDeviceHostEditor, SimlockDeviceHostEditor):
// the "Device sources" card of the Devices page. Local simulators, then each configured SSH machine, EAS account and
// Simlock pool as a row with its platforms and status, an Edit button and a More menu (Test connection, Remove);
// "Add source" opens the matching editor. Shown while devices are on.
import { signal, Text, token, View } from "nsh";
const token_ = token;
import { DialogInput as Input } from "../../components/DialogInput";
import { Menu, MenuItem } from "nsh/base";
import { DialogField, SettingsDialog } from "../../components/SettingsDialog";
import { SettingsButton, SettingsSection, SettingsSelect } from "../../components/SettingsLayout";
import { showToast } from "../../components/toast";
import { MENU_ITEM_ROW_CLASS } from "../../components/menuStyles";
import { trackOpenChange, useOverlayOpen } from "../../components/rightPanel/nativeOcclusion";
import { SettingsIcon } from "./SettingsIcon";
import { replaceServerSettings, serverEnvironment, serverSettings } from "./settingsState";
import { isServerConnected, requestServer } from "./settingsSync";
import { isProjectScope } from "./scopeState";
import { settingsWriteDenied } from "./settingsWriteAccess";
import { registerSettingsRow } from "./settingsSearchNav";
import { DeviceHostAvailability } from "../../components/device/DeviceHostAvailability";
import { compareNumeric, DeviceToolVersions, readDeviceToolVersions, type DeviceToolKind } from "../../components/device/DeviceToolVersions";
import {
  cleanSshHost, easDraftError, easSessionLimits, hostPlatforms, hostStatus, newEasHost, newSimlockHost, newSshHost, readEasHosts, readSimlockHosts, readSshHosts, simlockDescription, simlockDraftError,
  easAccountInput, easAccountMessage, readEasAccount, readSimlockIdentity, simlockIdentityInput, simlockIdentityMessage,
  sshDraftError, updateEasHosts, updateSimlockHosts, updateSshHosts, type EasHost, type HostStatus, type Platform, type SimlockHost, type SshHost,
} from "./deviceSourcesLogic";

type Dict = Record<string, unknown>;
type Editing = { kind: "ssh"; host: SshHost; original: SshHost | null } | { kind: "eas"; host: EasHost; isNew: boolean } | { kind: "simlock"; host: SimlockHost; isNew: boolean };

const settings = () => serverSettings() as Dict | null;
const state = signal<Dict | null>(null);
const editing = signal<Editing | null>(null);
const busy = signal(false);
const testing = signal<string[]>([]);
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export async function loadDeviceState() {
  try { state.set((await requestServer("device.list", { inspectOnly: true })) as Dict); } catch { state.set(null); }
}

/** DeviceIntegrationControls' update: device.configure on the environment (enabling also completes onboarding), then the
 * hub state again. A denied or failed configure names the environment it could not update. */
export async function configureDevices(input: { enabled?: boolean; agentAccessEnabled?: boolean }, request: (method: string, payload: unknown) => Promise<unknown> = requestServer, denied: () => boolean = settingsWriteDenied): Promise<boolean> {
  const label = typeof serverEnvironment()?.label === "string" && serverEnvironment()!.label ? String(serverEnvironment()!.label) : "this environment";
  busy.set(true);
  try {
    if (!isServerConnected()) throw new Error("Environment disconnected");
    if (denied()) throw new Error("This connection cannot change device settings.");
    await request("device.configure", { ...input, ...(input.enabled ? { onboardingCompleted: true } : {}) });
    void loadDeviceState();
    return true;
  } catch {
    showToast({ type: "error", title: "Device settings not saved on all environments", description: `Could not update ${label}.` });
    return false;
  } finally {
    busy.set(false);
  }
}

async function write(patch: Dict, failedTitle: string): Promise<boolean> {
  if (isProjectScope()) return false;
  busy.set(true);
  try {
    replaceServerSettings(await requestServer("server.updateSettings", { patch }));
    void loadDeviceState();
    return true;
  } catch (cause) {
    showToast({ type: "error", title: failedTitle, description: message(cause) });
    return false;
  } finally {
    busy.set(false);
  }
}

const randomId = () => crypto.randomUUID();

async function saveSsh(host: SshHost, remove: boolean, original: SshHost = host) {
  try {
    if (await write({ deviceHosts: updateSshHosts(readSshHosts(settings()), host, remove, original) }, remove ? "Device host not removed everywhere" : "Device host not saved everywhere")) editing.set(null);
  } catch (cause) {
    showToast({ type: "error", title: "Device host not saved", description: message(cause) });
  }
}
async function saveEas(host: EasHost, remove: boolean, previous?: EasHost) {
  const keepToken = previous !== undefined && host.accessToken === previous.accessToken;
  if (await write({ easDeviceHosts: updateEasHosts(readEasHosts(settings()), host, remove, keepToken) }, remove ? "EAS host not removed everywhere" : "EAS host not saved everywhere")) editing.set(null);
}
async function saveSimlock(host: SimlockHost, remove: boolean, previous?: SimlockHost) {
  const keepToken = previous !== undefined && host.agentToken === previous.agentToken;
  if (await write({ simlockDeviceHosts: updateSimlockHosts(readSimlockHosts(settings()), host, remove, keepToken) }, remove ? "Simlock host not removed everywhere" : "Simlock host not saved everywhere")) editing.set(null);
}

/** One environment's connection check (deviceHostConnectionChecks.ts DeviceHostCheck). */
export type HostCheck = { status: "pending" } | { status: "local" } | { status: "connected"; platforms?: Platform[] } | { status: "failed"; error: string };

/** checkDeviceHostConnections for this client's one environment: settings:write first (useHostConnectionChecks), then the probe. */
export async function checkSshHost(host: SshHost, request: (method: string, payload: unknown) => Promise<unknown> = requestServer, denied: () => boolean = settingsWriteDenied): Promise<HostCheck> {
  try {
    if (!isServerConnected()) throw new Error("Environment disconnected");
    if (denied()) throw new Error("This connection cannot test device hosts.");
    const result = (await request("device.testHost", cleanSshHost(host))) as { kind?: unknown; platforms?: Platform[] } | null;
    return result?.kind === "local" ? { status: "local" } : { status: "connected", ...(Array.isArray(result?.platforms) ? { platforms: result!.platforms } : {}) };
  } catch (cause) {
    return { status: "failed", error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** testSsh: probe the destination from the environment (`device.testHost`); a failure names why. */
async function testSsh(host: SshHost) {
  testing.update((all) => [...all, host.id]);
  try {
    const result = await checkSshHost(host);
    if (result.status === "failed") showToast({ type: "error", title: `${host.label}: 1 of 1 environments failed`, description: result.error });
    else showToast({ type: "success", title: `${host.label}: connection checks passed`, description: "Connected or already available locally on each selected environment." });
  } finally {
    testing.update((all) => all.filter((id) => id !== host.id));
  }
}

function PlatformMarks(props: { platforms: Platform[] | undefined; title: string }) {
  const marks = () => (["ios", "android"] as const).filter((platform) => props.platforms?.some((entry) => entry.platform === platform));
  return (
    <Each of={[...marks()]} key={(platform) => platform}>
      {(platform) => {
        const entry = () => props.platforms?.find((item) => item.platform === platform());
        const available = () => entry()?.available === true;
        const name = () => (platform() === "ios" ? "iOS" : "Android");
        // DeviceAvailabilityMark's popup: the platform's state, and for a missing one why (else "Not set up on this machine.").
        const tip = () => available() ? `${name()} available` : `${name()} not available\n${entry()?.reason ?? "Not set up on this machine."}`;
        return (
          <View tooltip={tip()} accessibilityLabel={`${props.title}: ${name()} ${available() ? "available" : "not available"}`} class={`size-6 items-center justify-center rounded-md ${available() ? "" : "opacity-45"}`}>
            <SettingsIcon name={platform() === "ios" ? "apple" : "android"} size={14} tint={token("foreground")} />
          </View>
        );
      }}
    </Each>
  );
}

function Row(props: { first: boolean; title: string; kind?: string; description: string; platforms?: Platform[]; status?: HostStatus; actions?: any; testID: string }) {
  return (
    <View class={props.first ? "" : "border-t border-border-60"} testID={props.testID}>
      <View class="flex-row items-center gap-3 px-4 py-3">
        <View class="min-w-0 flex-1 gap-0.5">
          <View class="min-w-0 flex-row items-center gap-1.5">
            <Text class="truncate text-sm font-medium text-foreground">{props.title}</Text>
            {props.kind ? <View class="shrink-0 rounded border border-border px-1"><Text class="text-3xs uppercase tracking-wide text-muted-foreground">{props.kind}</Text></View> : null}
          </View>
          <Text class="truncate text-xs text-muted-foreground">{props.description}</Text>
          {props.status ? <Text class={`text-xs ${props.status.tone === "error" ? "text-destructive-foreground" : props.status.tone === "warning" ? "text-warning-foreground" : "text-muted-foreground"}`}>{props.status.detail ? `${props.status.label} · ${props.status.detail}` : props.status.label}</Text> : null}
        </View>
        <View class="shrink-0 flex-row items-center gap-0.5"><PlatformMarks platforms={props.platforms} title={props.title} /></View>
        {props.actions ?? null}
      </View>
    </View>
  );
}

function RowActions(props: { title: string; onEdit: () => void; onRemove: () => void; extra?: { label: string; run: () => void } }) {
  const open = signal(false);
  useOverlayOpen(open, "device source menu");
  const disabled = () => isProjectScope() || busy();
  return (
    <>
      <SettingsButton label="Edit" accessibilityLabel={`Edit ${props.title}`} disabled={disabled()} onPress={props.onEdit} />
      <Menu
        popupClass="min-w-36 rounded-lg border border-border bg-popover-84 p-1"
        align="end"
        onOpenChange={trackOpenChange(open)}
        trigger={<View role="button" accessibilityLabel={`More for ${props.title}`} class="size-7 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"><SettingsIcon name="ellipsis" size={16} /></View>}
      >
        {props.extra ? <MenuItem accessibilityLabel={props.extra.label} class={MENU_ITEM_ROW_CLASS} onSelect={props.extra.run}><Text class="text-sm text-popover-foreground">{props.extra.label}</Text></MenuItem> : null}
        <MenuItem accessibilityLabel={`Remove ${props.title}`} class={MENU_ITEM_ROW_CLASS} onSelect={props.onRemove}><Text class="text-sm text-destructive-foreground">Remove</Text></MenuItem>
      </Menu>
    </>
  );
}

const field = "h-7.5 rounded-lg border border-input bg-background px-3 text-sm text-foreground";
const numberOr = (text: string, fallback: number) => { const value = Number(text); return Number.isFinite(value) && text.trim() !== "" ? value : fallback; };

function SshEditor(props: { host: SshHost; original: SshHost | null }) {
  const label = signal(props.host.label);
  const target = signal(props.host.target);
  const port = signal(props.host.port === undefined ? "" : String(props.host.port));
  const identity = signal(props.host.identityFile ?? "");
  const draft = (): SshHost => ({ ...props.host, label: label(), target: target(), ...(port().trim() ? { port: numberOr(port(), NaN) } : {}), ...(identity().trim() ? { identityFile: identity() } : {}) });
  const error = () => sshDraftError(draft());
  // DeviceHostEditor.tsx: SSH options open when the host already sets a port or identity file.
  const optionsOpen = signal(props.host.port !== undefined || props.host.identityFile !== undefined);
  const check = signal<HostCheck | null>(null);
  const errorShown = signal(false);
  const checking = () => testing().includes(props.host.id) || check()?.status === "pending";
  const runCheck = async () => {
    check.set({ status: "pending" }); errorShown.set(false);
    check.set(await checkSshHost(draft()));
  };
  const summary = () => checking() ? "Checking environments…" : check() ? (check()!.status === "failed" ? "1 of 1 failed" : "Connection checks passed") : "Check access before saving";
  const from = () => (typeof serverEnvironment()?.label === "string" && serverEnvironment()!.label ? String(serverEnvironment()!.label) : "this environment");
  // The form's labels are `block space-y-1.5 text-sm` spans, not the dialogs' small field labels.
  const Field = (fieldProps: { label: string; class?: string; children: any }) => (
    <View class={`gap-1.5 ${fieldProps.class ?? ""}`}><Text class="text-sm text-foreground">{fieldProps.label}</Text>{fieldProps.children}</View>
  );
  return (
    <SettingsDialog
      open
      onClose={() => editing.set(null)}
      title={props.original === null ? "Add device host" : "Edit device host"}
      description={`Connect from ${from()}. Hosts on the same machine are skipped.`}
      testID="Device host editor"
      footer={<><SettingsButton label="Cancel" tone="ghost" onPress={() => editing.set(null)} /><SettingsButton label="Save host" tone="primary" disabled={error() !== null || busy() || checking() || !label().trim()} onPress={() => void saveSsh(cleanSshHost(draft()), false, props.original ?? undefined)} /></>}
    >
      <Field label="Name"><Input value={label()} placeholder="Mac mini" accessibilityLabel="Host name" onChange={(e: { value: string }) => label.set(e.value)} class={field} /></Field>
      <Field label="SSH target"><Input value={target()} placeholder="user@host or SSH alias" accessibilityLabel="SSH destination" onChange={(e: { value: string }) => target.set(e.value)} class={field} /></Field>
      <View class="gap-3">
        <View role="button" accessibilityLabel="SSH options" accessibilityState={{ expanded: optionsOpen() }} onPress={() => optionsOpen.set(!optionsOpen())} class="flex-row items-center gap-1 self-start">
          <View style={{ transform: optionsOpen() ? "rotate(90deg)" : "rotate(0deg)" }}><SettingsIcon name="play" size={8} tint={token("muted-foreground")} /></View>
          <Text class="text-sm text-muted-foreground">SSH options</Text>
        </View>
        {optionsOpen() ? (
          <View class="gap-2">
            <View class="flex-row gap-3">
              <Field label="Identity file" class="min-w-0 flex-1"><Input value={identity()} placeholder="SSH config default" accessibilityLabel="SSH identity file" onChange={(e: { value: string }) => identity.set(e.value)} class={field} /></Field>
              <Field label="Port" class="w-28"><Input value={port()} placeholder="Default" accessibilityLabel="SSH port" onChange={(e: { value: string }) => port.set(e.value)} class={field} /></Field>
            </View>
            <Text class="text-xs text-muted-foreground">Optional. Resolved separately on each environment.</Text>
          </View>
        ) : null}
      </View>
      <View class="flex-row items-center justify-between gap-3 rounded-lg border border-border-60 px-3 py-2.5">
        <Text class="text-xs text-muted-foreground">{summary()}</Text>
        <SettingsButton label="Test connection" disabled={busy() || checking() || error() !== null} onPress={() => void runCheck()} />
      </View>
      {check() && check()!.status !== "pending" ? (
        <View class="gap-1.5 rounded-lg border border-border-60 px-3 py-2" testID="Device host check">
          <View class="flex-row items-center justify-between gap-3">
            <Text class="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{from()}</Text>
            <Text class={`text-xs ${check()!.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground"}`}>{check()!.status === "local" ? "Already available locally" : check()!.status === "failed" ? "Failed" : "Connected"}</Text>
          </View>
          {check()!.status === "connected" && (check() as { platforms?: Platform[] }).platforms ? <DeviceHostAvailability platforms={(check() as { platforms: Platform[] }).platforms} /> : null}
          {check()!.status === "failed" ? (
            <View class="gap-1">
              <View role="button" accessibilityLabel="Show error" accessibilityState={{ expanded: errorShown() }} onPress={() => errorShown.set(!errorShown())} class="self-start"><Text class="text-xs text-muted-foreground">Show error</Text></View>
              {errorShown() ? <Text class="text-xs text-muted-foreground">{(check() as { error: string }).error}</Text> : null}
            </View>
          ) : null}
        </View>
      ) : null}
      {error() && (label().trim() || target().trim()) ? <Text class="text-xs text-destructive-foreground">{error()}</Text> : null}
    </SettingsDialog>
  );
}

const FROM_THREAD_PROJECT = "__from-thread-project__";

function EasEditor(props: { host: EasHost; isNew: boolean }) {
  const label = signal(props.host.label);
  const appId = signal(props.host.appId ?? "");
  const token = signal(typeof props.host.accessToken === "string" ? props.host.accessToken : "");
  const session = signal(String(props.host.maxSessionMinutes));
  const idle = signal(String(props.host.idleMinutes));
  const sessions = signal(String(props.host.maxConcurrentSessions));
  const account = signal("");
  const apps = signal<{ id: string; fullName: string }[]>([]);
  const checking = signal(false);
  // A check answers for the credential it was asked about: a later check or a token edit makes an earlier answer stale
  // (EasDeviceHostEditor latestCheck / resetAccount).
  let latestCheck = 0;
  const resetAccount = () => { latestCheck++; checking.set(false); account.set(""); apps.set([]); };
  const checkAccount = async () => {
    const run = ++latestCheck;
    checking.set(true);
    account.set("Checking the Expo account…");
    try {
      const result = readEasAccount(await requestServer("device.easAccount", easAccountInput(props.host, token(), props.isNew)));
      if (run !== latestCheck) return;
      account.set(result ? easAccountMessage(result) : "The server did not return an account.");
      apps.set(result?.apps ?? []);
    } catch (cause) {
      if (run !== latestCheck) return;
      account.set(message(cause));
      apps.set([]);
    } finally {
      if (run === latestCheck) checking.set(false);
    }
  };
  // The reference checks as the editor opens, so the saved project and a rejected credential show before anything is changed.
  void checkAccount();
  const draft = (): EasHost => ({ ...props.host, label: label(), ...(appId().trim() ? { appId: appId().trim() } : {}), accessToken: token(), maxSessionMinutes: numberOr(session(), NaN), idleMinutes: numberOr(idle(), NaN), maxConcurrentSessions: numberOr(sessions(), NaN) });
  const error = () => easDraftError(draft());
  // EAS project: "From the thread's project", the saved id when the account does not list it, then the account's projects.
  const projectOptions = () => [
    { value: FROM_THREAD_PROJECT, label: "From the thread's project" },
    ...(appId() && !apps().some((entry) => entry.id === appId()) ? [{ value: appId(), label: appId() }] : []),
    ...apps().map((entry) => ({ value: entry.id, label: entry.fullName })),
  ];
  return (
    <SettingsDialog
      open
      onClose={() => editing.set(null)}
      title={props.isNew ? "Add EAS host" : "Edit EAS host"}
      description="The environment's server signs in to Expo and starts the sessions. Without a token here it uses EXPO_TOKEN, then its eas login."
      testID="EAS host editor"
      footer={<><SettingsButton label="Cancel" onPress={() => editing.set(null)} /><SettingsButton label="Save host" tone="primary" disabled={error() !== null || busy()} onPress={() => void saveEas(draft(), false, props.isNew ? undefined : props.host)} /></>}
    >
      <DialogField label="Name"><Input value={label()} accessibilityLabel="EAS source name" onChange={(e: { value: string }) => label.set(e.value)} class={field} /></DialogField>
      <DialogField label="Expo access token">
        <View class="flex-row items-center gap-2">
          <Input value={token()} masked placeholder="Optional" accessibilityLabel="Expo access token" onChange={(e: { value: string }) => { token.set(e.value); resetAccount(); }} class={`${field} min-w-0 flex-1`} />
          {token() ? <View role="button" accessibilityLabel="Clear access token" onPress={() => { token.set(""); resetAccount(); }} class="size-7 items-center justify-center rounded-md hover:bg-accent"><SettingsIcon name="x" size={14} tint={token_("destructive-foreground")} /></View> : null}
        </View>
      </DialogField>
      <View class="flex-row items-center justify-between gap-3 rounded-lg border border-border-60 px-3 py-2.5">
        <Text class="min-w-0 flex-1 text-xs text-muted-foreground">{account() || "Check the Expo account before choosing a project."}</Text>
        <SettingsButton label="Check account" disabled={checking()} onPress={() => void checkAccount()} />
      </View>
      <DialogField label="EAS project">
        <SettingsSelect label="EAS project" value={appId() || FROM_THREAD_PROJECT} options={projectOptions()} onChange={(next) => appId.set(next === FROM_THREAD_PROJECT ? "" : next)} />
        <Text class="text-xs text-muted-foreground">{`Sessions bill the project's Expo account. "From the thread's project" reads extra.eas.projectId from the project's app config.`}</Text>
      </DialogField>
      <View class="flex-row gap-3">
        <DialogField label="Sessions at once" class="min-w-0 flex-1"><Input value={sessions()} accessibilityLabel="Sessions at once" onChange={(e: { value: string }) => sessions.set(e.value)} class={field} /></DialogField>
        <DialogField label="Session minutes" class="min-w-0 flex-1"><Input value={session()} accessibilityLabel="Session minutes" onChange={(e: { value: string }) => session.set(e.value)} class={field} /></DialogField>
        <DialogField label="Idle minutes" class="min-w-0 flex-1"><Input value={idle()} accessibilityLabel="Idle minutes" onChange={(e: { value: string }) => idle.set(e.value)} class={field} /></DialogField>
      </View>
      <Text class="text-xs text-muted-foreground">{`Expo allows sessions of up to 40 minutes on free accounts and 115 on paid ones, and ends one after the idle minutes without activity, so idle minutes must be smaller than session minutes.${props.isNew ? "" : " Saving restarts this host, which stops its running sessions."}`}</Text>
      {error() ? <Text role="alert" class="text-xs text-destructive-foreground">{error()}</Text> : null}
    </SettingsDialog>
  );
}

function SimlockEditor(props: { host: SimlockHost; isNew: boolean }) {
  const label = signal(props.host.label);
  const gateway = signal(props.host.gatewayUrl);
  const agentToken = signal(typeof props.host.agentToken === "string" ? props.host.agentToken : "");
  const leases = signal(String(props.host.maxLeases));
  const minutes = signal(String(props.host.maxLeaseMinutes));
  const identity = signal("");
  const checking = signal(false);
  let latestCheck = 0;
  const resetIdentity = () => { latestCheck++; checking.set(false); identity.set(""); };
  const checkToken = async () => {
    const run = ++latestCheck;
    checking.set(true);
    identity.set("Checking the token…");
    try {
      const result = readSimlockIdentity(await requestServer("device.simlockIdentity", simlockIdentityInput({ id: props.host.id, gatewayUrl: gateway() }, agentToken(), props.isNew)));
      if (run !== latestCheck) return;
      identity.set(result ? simlockIdentityMessage(result) : "The gateway did not answer.");
    } catch (cause) {
      if (run !== latestCheck) return;
      identity.set(message(cause));
    } finally {
      if (run === latestCheck) checking.set(false);
    }
  };
  // SimlockTokenField checks whenever a valid gateway URL is present, so a saved host shows who its token is as it opens.
  if (!props.isNew && gateway().trim()) void checkToken();
  const draft = (): SimlockHost => ({ ...props.host, label: label(), gatewayUrl: gateway().trim(), agentToken: agentToken(), maxLeases: numberOr(leases(), NaN), maxLeaseMinutes: numberOr(minutes(), NaN) });
  const error = () => simlockDraftError(draft());
  return (
    <SettingsDialog
      open
      onClose={() => editing.set(null)}
      title={props.isNew ? "Add Simlock host" : "Edit Simlock host"}
      description="The environment's server leases devices from your Simlock gateway and releases them when they close."
      testID="Simlock host editor"
      footer={<><SettingsButton label="Cancel" onPress={() => editing.set(null)} /><SettingsButton label="Save host" tone="primary" disabled={error() !== null || busy()} onPress={() => void saveSimlock(draft(), false, props.isNew ? undefined : props.host)} /></>}
    >
      <DialogField label="Name"><Input value={label()} accessibilityLabel="Simlock pool name" onChange={(e: { value: string }) => label.set(e.value)} class={field} /></DialogField>
      <DialogField label="Gateway URL"><Input value={gateway()} placeholder="https://gateway.example.ts.net:4700" accessibilityLabel="Simlock gateway URL" onChange={(e: { value: string }) => gateway.set(e.value)} class={field} /></DialogField>
      <DialogField label="Agent token">
        <View class="flex-row items-center gap-2">
          <Input value={agentToken()} masked accessibilityLabel="Agent token" onChange={(e: { value: string }) => { agentToken.set(e.value); resetIdentity(); }} class={`${field} min-w-0 flex-1`} />
          {agentToken() ? <View role="button" accessibilityLabel="Clear agent token" disabled={busy()} onPress={() => { agentToken.set(""); resetIdentity(); }} class="size-7 items-center justify-center rounded-md hover:bg-accent"><SettingsIcon name="x" size={14} tint={token_("destructive-foreground")} /></View> : null}
        </View>
        <Text class="text-xs text-muted-foreground">Leases, drives, and streams devices. Create one with <Text class="font-mono text-xs">simlock --gateway token create --role agent</Text>, or leave it blank to add it later. A blank token uses the machine's <Text class="font-mono text-xs">AGENT_DEVICE_DAEMON_AUTH_TOKEN</Text> when its <Text class="font-mono text-xs">AGENT_DEVICE_DAEMON_BASE_URL</Text> is this gateway.</Text>
      </DialogField>
      <View class="flex-row items-center justify-between gap-3 rounded-lg border border-border-60 px-3 py-2.5">
        <Text class="min-w-0 flex-1 text-xs text-muted-foreground">{identity() || "Check the token against the gateway."}</Text>
        <SettingsButton label="Check token" disabled={checking() || !gateway().trim()} onPress={() => void checkToken()} />
      </View>
      <View class="flex-row gap-3">
        <DialogField label="Devices at once" class="min-w-0 flex-1"><Input value={leases()} accessibilityLabel="Devices at once" onChange={(e: { value: string }) => leases.set(e.value)} class={field} /></DialogField>
        <DialogField label="Lease minutes" class="min-w-0 flex-1"><Input value={minutes()} accessibilityLabel="Lease minutes" onChange={(e: { value: string }) => minutes.set(e.value)} class={field} /></DialogField>
      </View>
      <Text class="text-xs text-muted-foreground">{`A lease ends after the lease minutes even while in use.${props.isNew ? "" : " Saving restarts this host, which releases its devices."}`}</Text>
      {error() && gateway().trim() ? <Text role="alert" class="text-xs text-destructive-foreground">{error()}</Text> : null}
    </SettingsDialog>
  );
}

function AddSource() {
  const open = signal(false);
  useOverlayOpen(open, "add device source menu");
  const simlockOn = () => settings()?.simlockDeviceHostsEnabled === true;
  return (
    <Menu
      // ui/menu.tsx MenuPopup default: min-w-40, as wide as its rows.
      popupClass="min-w-40 w-max rounded-lg border border-border bg-popover-84 p-1"
      align="end"
      onOpenChange={trackOpenChange(open)}
      trigger={
        <View role="button" accessibilityLabel="Add source" class="h-7 flex-row items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out">
          <SettingsIcon name="plus" size={14} />
          <Text class="text-sm font-medium text-foreground">Add source</Text>
          <SettingsIcon name="chevron-down" size={14} />
        </View>
      }
    >
      <MenuItem accessibilityLabel="Machine over SSH" class={MENU_ITEM_ROW_CLASS} onSelect={() => editing.set({ kind: "ssh", host: newSshHost(randomId()), original: null })}><Text class="text-sm text-popover-foreground">Machine over SSH</Text></MenuItem>
      <MenuItem accessibilityLabel="EAS Simulator" class={MENU_ITEM_ROW_CLASS} onSelect={() => editing.set({ kind: "eas", host: newEasHost(randomId()), isNew: true })}><Text class="text-sm text-popover-foreground">EAS Simulator</Text></MenuItem>
      {simlockOn() ? <MenuItem accessibilityLabel="Simlock pool (alpha)" class={MENU_ITEM_ROW_CLASS} onSelect={() => editing.set({ kind: "simlock", host: newSimlockHost(randomId()), isNew: true })}><Text class="text-sm text-popover-foreground">Simlock pool (alpha)</Text></MenuItem> : null}
    </Menu>
  );
}

/** DeviceToolVersions' trigger text for the local host's hub or agent-device: the running or best installed version,
 * "Not installed" when the tool is known but absent, else "Version unknown". */
export function deviceToolLabel(kind: "hub" | "agent"): string {
  // Reads the state DeviceSources loads on the same page; loading here too re-ran the load on every read.
  const local = Array.isArray(state()?.hosts) ? (state()!.hosts as Dict[]).find((host) => host.kind === "local") : undefined;
  const tools = local?.tools as Record<string, { runningVersion?: string; requiredVersion?: string; installedVersions?: string[] } | undefined> | undefined;
  const selected = tools?.[kind];
  const installed = selected?.installedVersions ?? [];
  const version = selected?.runningVersion ?? (selected?.requiredVersion && installed.includes(selected.requiredVersion) ? selected.requiredVersion : [...installed].sort(compareNumeric).at(-1));
  return version ? `v${version}` : selected ? "Not installed" : "Version unknown";
}

/** IntegrationsSettings' DeviceToolVersions for the local host's hub or agent-device, with versionActions: Update when the
 * required version is not installed (supportsToolUpdate), Check versions (supportsToolInspection), the update's error. */
const toolPending = signal<string | null>(null);
const toolUpdateError = signal<{ tool: DeviceToolKind; message: string } | null>(null);
export function DeviceToolVersionsTail(props: { kind: DeviceToolKind }) {
  const local = () => (Array.isArray(state()?.hosts) ? (state()!.hosts as Dict[]).find((host) => host.kind === "local") : undefined);
  const tools = () => readDeviceToolVersions(local()?.tools);
  const version = () => tools()?.[props.kind];
  const needsUpdate = () => { const v = version(); return !!v && !v.installedVersions.includes(v.requiredVersion); };
  const run = (pending: string, input: Dict) => {
    toolPending.set(pending);
    if (pending.startsWith("update-")) toolUpdateError.set(null);
    void requestServer("device.list", input)
      .then((next) => state.set(next as Dict))
      .catch((cause) => { if (pending.startsWith("update-")) toolUpdateError.set({ tool: props.kind, message: message(cause) }); })
      .finally(() => toolPending.set(null));
  };
  const action = () => (
    <View class="gap-2">
      <View class="flex-row flex-wrap gap-2">
        {state()?.supportsToolUpdate === true && needsUpdate() ? <SettingsButton label={toolPending() === `update-${props.kind}` ? "Updating…" : "Update"} tone="primary" disabled={!isServerConnected() || toolPending() !== null || busy()} onPress={() => run(`update-${props.kind}`, { updateTool: props.kind })} /> : null}
        {state()?.supportsToolInspection === true ? <SettingsButton label={toolPending() === "check" ? "Checking…" : "Check versions"} disabled={!isServerConnected() || toolPending() !== null || busy()} onPress={() => run("check", { inspectOnly: true })} /> : null}
      </View>
      {toolUpdateError()?.tool === props.kind ? <Text role="alert" class="text-xs text-destructive">{toolUpdateError()!.message}</Text> : null}
    </View>
  );
  return <DeviceToolVersions kind={props.kind} tools={tools()} action={action()} />;
}

export function DeviceSources() {
  void loadDeviceState();
  const local = () => (Array.isArray(state()?.hosts) ? (state()!.hosts as Dict[]).find((host) => host.kind === "local") : undefined);
  const ssh = () => readSshHosts(settings());
  const eas = () => readEasHosts(settings());
  const simlock = () => (settings()?.simlockDeviceHostsEnabled === true ? readSimlockHosts(settings()) : []);
  return (
    <>
      {/* DeviceSourcesSettings draws whether or not the hub is on (IntegrationsSettings.tsx). */}
      {isServerConnected() ? (
        <View ref={(node: any) => registerSettingsRow("/settings/devices", "device-sources", node)}><SettingsSection title="Device sources" headerAction={<AddSource />}>
          <Row first testID="Device source local" title="Local simulators" description="Simulators and emulators installed on this environment's machine." platforms={(local()?.platforms as Platform[] | undefined)} status={hostStatus(state(), String(local()?.id ?? ""))} />
          <Each of={ssh()} key={(host) => host.id}>
            {(host) => (
              <Row
                first={false}
                testID={`Device source ${host().label}`}
                title={host().label}
                kind="SSH"
                description={host().target}
                platforms={hostPlatforms(state(), host().id)}
                status={testing().includes(host().id) ? { tone: "pending", label: "Testing connection" } : hostStatus(state(), host().id)}
                actions={<RowActions title={host().label} onEdit={() => editing.set({ kind: "ssh", host: host(), original: host() })} onRemove={() => void saveSsh(host(), true)} extra={{ label: "Test connection", run: () => void testSsh(host()) }} />}
              />
            )}
          </Each>
          <Each of={eas()} key={(host) => host.id}>
            {(host) => (
              <Row first={false} testID={`Device source ${host().label}`} title={host().label} kind="EAS" description={easSessionLimits(host())} platforms={hostPlatforms(state(), host().id)} status={hostStatus(state(), host().id)} actions={<RowActions title={host().label} onEdit={() => editing.set({ kind: "eas", host: host(), isNew: false })} onRemove={() => void saveEas(host(), true)} />} />
            )}
          </Each>
          <Each of={simlock()} key={(host) => host.id}>
            {(host) => (
              <Row first={false} testID={`Device source ${host().label}`} title={host().label} kind="Simlock" description={simlockDescription(host())} platforms={hostPlatforms(state(), host().id)} status={hostStatus(state(), host().id)} actions={<RowActions title={host().label} onEdit={() => editing.set({ kind: "simlock", host: host(), isNew: false })} onRemove={() => void saveSimlock(host(), true)} />} />
            )}
          </Each>
        </SettingsSection></View>
      ) : null}
      {editing()?.kind === "ssh" ? <SshEditor host={(editing() as Extract<Editing, { kind: "ssh" }>).host} original={(editing() as Extract<Editing, { kind: "ssh" }>).original} /> : null}
      {editing()?.kind === "eas" ? <EasEditor host={(editing() as Extract<Editing, { kind: "eas" }>).host} isNew={(editing() as Extract<Editing, { kind: "eas" }>).isNew} /> : null}
      {editing()?.kind === "simlock" ? <SimlockEditor host={(editing() as Extract<Editing, { kind: "simlock" }>).host} isNew={(editing() as Extract<Editing, { kind: "simlock" }>).isNew} /> : null}
    </>
  );
}
