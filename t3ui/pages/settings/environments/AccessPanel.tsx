// The Sharing & access page (ConnectionsSettings view="access"): the connected environment's section
// ("More actions" menu with its Icon, Version, Network access, Permissions) and the folded "Authorized
// clients" list: pairing links with Share, Copy code and Revoke, signed-in clients with Revoke, and the
// header's Use in another app (MCP), Revoke others and Create link (a modal with the client label and the
// permissions it may delegate). No environment: "No environment selected".
//
// With a launcher that publishes network access (desktop/NetworkAccessRows.tsx) the section has the desktop rows;
// otherwise it is the reference's bridge-less one: Network access is
// a disabled row that reads the server's auth policy (`renderDisabledNetworkAccessRow`), then the T3 Connect rows
// (CloudLinkRow.tsx) for a session with relay:read or relay:write.
import { FadeScroll } from "../../../components/FadeScroll";
import { CloudLinkRow } from "./CloudLinkRow";
import { NetworkAccessRows, networkAccessAvailable } from "../../../desktop/NetworkAccessRows";
import { effect, Scroll, signal, Text, View } from "nsh";
import { Menu, MenuItem } from "nsh/base";
import { DialogInput as Input } from "../../../components/DialogInput";
import { backendStatus, backendUrl, localServerEngine } from "../../../store";
import { SettingsButton, SettingsRow, SettingsSection, SettingsSwitch } from "../../../components/SettingsLayout";
import { DialogField, SettingsDialog } from "../../../components/SettingsDialog";
import { ManagedByOrganization } from "../../../components/coordinators/ManagedPolicy";
import { openUseInAnotherApp } from "../../../components/mcp/useInAnotherAppState";
import { showToast } from "../../../components/toast";
import { Tip } from "../../../components/sidebar/Tip";
import { ManagedControl } from "../providers/ui";
import { managedCapabilityDenial, managedSettingLock } from "../managedPolicyLocks";
import { SettingsIcon } from "../SettingsIcon";
import { replaceServerSettings, serverEnvironment, serverManagedPolicy, serverSettings } from "../settingsState";
import { requestServer } from "../settingsSync";
import { SearchAnchor } from "../SearchAnchor";
import { resolveVersionMismatch } from "../../../components/coordinators/connection.logic";
import {
  accessState, canRevokeOtherClients, createdCredentials, createPairingLink, PAIRING_SCOPE_OPTIONS,
  revokeClientSession, revokeOtherClients, revokePairingLink, sortClientSessions, summarizeAuthorizedClients, watchAccess,
} from "./accessClients";
import { accessSession, loadAccessSession, sessionHolds } from "./accessSession";
import {
  NETWORK_ACCESS_TOOLTIP, networkAccessWithoutBridge, READ_ONLY_PAIRING_SCOPES, sessionPermissionsUnavailableMessage, STANDARD_PAIRING_SCOPES,
  togglePairingScopeSelection, type AdvertisedEndpoint,
} from "./connectionsLogic";
import { EnvironmentIconMenu } from "./EnvironmentIconMenu";
import { localEnvironmentEnabled } from "./LocalEnvironment";
import { MachineIcon, resolveEnvironmentMachineKind } from "./MachineIcon";
import { ConnectedClientRow, PairingLinkRow } from "./PairingLinkRow";

const open = signal(false);
const permissionsOpen = signal(false);
const createOpen = signal(false);
let pairingDialogSession = 0;
const label = signal("");
const scopes = signal<string[]>([...STANDARD_PAIRING_SCOPES]);
const creating = signal(false);
const createError = signal("");
const problem = signal("");
const revoking = signal<string | null>(null);
const now = signal(Date.now());
const newestLinkId = signal<string | null>(null);
/** The endpoints the desktop bridge advertises (`getAdvertisedEndpoints`). This client has no bridge, so the list is empty. */
const advertisedEndpoints = signal<AdvertisedEndpoint[]>([]);
const defaultEndpointKey = signal<string | null>(null);

/** The permissions a new link may carry: what this session holds, or every one while the session is not read (the server enforces them). */
export function delegatableScopes(session = accessSession()): string[] {
  return session.status === "ready" && session.authenticated ? PAIRING_SCOPE_OPTIONS.map((option) => option.scope).filter((scope) => session.scopes.includes(scope)) : PAIRING_SCOPE_OPTIONS.map((option) => option.scope);
}

const holds = (scope: string): boolean => {
  const session = accessSession();
  // Unknown stays allowed (the server refuses what is not): the web hides these controls until its session loads.
  return session.status !== "ready" || !session.authenticated ? true : sessionHolds(session, scope);
};

function resetCreate() {
  label.set("");
  scopes.set(STANDARD_PAIRING_SCOPES.filter((scope) => delegatableScopes().includes(scope)));
  createError.set("");
}

function closeCreate() {
  pairingDialogSession += 1;
  createOpen.set(false);
  resetCreate();
}

async function guarded(id: string, run: () => Promise<unknown>, failure: { title: string; fallback: string }) {
  revoking.set(id);
  problem.set("");
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : failure.fallback;
    problem.set(message);
    showToast({ type: "error", title: failure.title, description: message });
  } finally {
    revoking.set(null);
  }
}

const DESTRUCTIVE_BUTTON = "h-6 items-center justify-center rounded-lg border border-destructive-foreground px-2 active:scale-[0.97] transition-transform duration-150 ease-in-out";

function ScopeOption(props: { scope: string; title: string; description: string }) {
  const on = () => scopes().includes(props.scope);
  return (
    <View
      role="button"
      accessibilityLabel={props.title}
      onPress={() => { if (!creating()) scopes.update((all) => togglePairingScopeSelection(all, props.scope, !all.includes(props.scope))); }}
      class="flex-row items-start gap-3 border-b border-border px-3 py-2.5 hover:bg-muted-40 transition-colors duration-150 ease-in-out"
    >
      <View class={`mt-0.5 size-4 items-center justify-center rounded-sm border ${on() ? "border-primary bg-primary" : "border-input bg-background"}`}>
        {on() ? <SettingsIcon name="check" size={10} /> : null}
      </View>
      <View class="min-w-0 flex-1">
        <Text class="text-xs font-medium text-foreground">{props.title}</Text>
        <Text class="text-xs leading-snug text-muted-foreground">{props.description}</Text>
      </View>
    </View>
  );
}

function CreateLinkDialog() {
  const selected = () => scopes().filter((scope) => delegatableScopes().includes(scope));
  const submit = async () => {
    if (creating() || selected().length === 0 || !holds("access:write") || !selected().every(holds)) return;
    const session = pairingDialogSession;
    creating.set(true);
    createError.set("");
    try {
      const id = await createPairingLink({ label: label(), scopes: selected() });
      newestLinkId.set(id);
      if (session === pairingDialogSession) closeCreate();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create pairing URL.";
      createError.set(message);
      showToast({ type: "error", title: "Could not create pairing URL", description: message });
    } finally {
      creating.set(false);
    }
  };
  return (
    <SettingsDialog
      open={createOpen()}
      onClose={closeCreate}
      title="Create pairing link"
      description="Generate a one-time link that another device can use to pair with this backend as an authorized client."
      width={448}
      testID="Create pairing link dialog"
      footerVariant="bare"
      footer={
        <>
          <SettingsButton label="Cancel" disabled={creating()} onPress={closeCreate} />
          <SettingsButton label={creating() ? "Creating…" : "Create link"} accessibilityLabel="Confirm create link" tone="primary" disabled={creating() || selected().length === 0} onPress={() => void submit()} />
        </>
      }
    >
      <DialogField label="Client label (optional)">
        <Input
          accessibilityLabel="Client label"
          value={label()}
          placeholder="e.g. Living room iPad"
          disabled={creating()}
          onChange={(event) => label.set(event.value)}
          onSubmit={() => void submit()}
          class="h-7.5 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground"
        />
      </DialogField>
      <View class="gap-3">
        <View class="flex-row items-center justify-between gap-3">
          <View class="min-w-0 flex-1">
            <Text class="text-xs font-medium text-foreground">Permissions</Text>
            <Text class="text-xs text-muted-foreground">Limit what the paired client can do.</Text>
          </View>
          <View class="flex-row gap-1">
            <SettingsButton label="Read only" disabled={creating()} onPress={() => scopes.set(READ_ONLY_PAIRING_SCOPES.filter((scope) => delegatableScopes().includes(scope)))} />
            <SettingsButton label="Standard" disabled={creating()} onPress={() => scopes.set(STANDARD_PAIRING_SCOPES.filter((scope) => delegatableScopes().includes(scope)))} />
          </View>
        </View>
        <View class="overflow-hidden rounded-lg border border-input bg-muted-30">
          {PAIRING_SCOPE_OPTIONS.filter((option) => delegatableScopes().includes(option.scope)).map((option) => <ScopeOption scope={option.scope} title={option.title} description={option.description} />)}
        </View>
        {selected().length === 0 ? (
          <Text class="text-xs text-destructive-foreground">Select at least one permission.</Text>
        ) : selected().includes("access:write") ? (
          <Text class="text-xs text-warning-foreground">This client can create or revoke access for other devices.</Text>
        ) : null}
      </View>
      {createError() ? <Text class="text-xs text-destructive-foreground">{createError()}</Text> : null}
    </SettingsDialog>
  );
}

/** AuthorizedClientsHeaderAction. */
function HeaderActions() {
  const sessions = () => sortClientSessions(accessState().clientSessions);
  const denial = () => managedCapabilityDenial(serverManagedPolicy(), "remoteClients");
  const createButton = (
    <View
      role="button"
      accessibilityLabel="Create link"
      disabled={denial() !== undefined}
      onPress={() => { resetCreate(); createOpen.set(true); }}
      class="h-6 flex-row items-center gap-1 rounded-lg bg-primary px-2 active:scale-[0.97] transition-transform duration-150 ease-in-out"
    >
      <SettingsIcon name="plus" size={12} />
      <Text class="text-xs font-medium text-primary-foreground">Create link</Text>
    </View>
  );
  return (
    <View class="flex-row flex-wrap items-center justify-end gap-2 py-1.5">
      <View
        role="button"
        accessibilityLabel="Use in another app (MCP)"
        onPress={() => openUseInAnotherApp()}
        class="h-6 flex-row items-center gap-1 rounded-lg border border-input bg-background px-2 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
      >
        <SettingsIcon name="plug" size={12} />
        <Text class="text-xs font-medium text-foreground">Use in another app (MCP)</Text>
      </View>
      <View
        role="button"
        accessibilityLabel="Revoke others"
        disabled={revoking() === "others" || !canRevokeOtherClients(accessState().loaded && accessState().error === null ? sessions() : null)}
        onPress={() => void guarded("others", async () => {
          const count = await revokeOtherClients();
          showToast({ type: "success", title: count === 1 ? "Revoked 1 other client" : `Revoked ${count} clients`, description: "Other paired clients will need a new pairing link before reconnecting." });
        }, { title: "Could not revoke other clients", fallback: "Failed to revoke other clients." })}
        class={DESTRUCTIVE_BUTTON}
      >
        <Text class="text-xs font-medium text-destructive-foreground">{revoking() === "others" ? "Revoking…" : "Revoke others"}</Text>
      </View>
      {denial() !== undefined ? <ManagedControl reason={denial()}><View class="opacity-60">{createButton}</View></ManagedControl> : createButton}
    </View>
  );
}

function AuthorizedClients() {
  const sessions = () => sortClientSessions(accessState().clientSessions);
  const links = () => accessState().pairingLinks.filter((link) => new Date(link.expiresAt).getTime() > now()).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const origin = () => { try { return new URL(backendUrl().replace(/^ws/, "http")).origin; } catch { return null; } };
  const newest = () => links().find((link) => link.id === newestLinkId()) ?? null;
  const row = (link: ReturnType<typeof links>[number]) => (
    <PairingLinkRow
      link={link}
      credential={createdCredentials()[link.id]}
      defaultShareOpen={link.id === newestLinkId()}
      currentOrigin={origin()}
      endpoints={advertisedEndpoints()}
      defaultEndpointKey={defaultEndpointKey()}
      now={now()}
      revoking={revoking() === link.id}
      canRevoke={holds("access:write")}
      onRevoke={() => void guarded(link.id, () => revokePairingLink(link.id), { title: "Could not revoke pairing link", fallback: "Failed to revoke pairing link." })}
    />
  );
  return (
    <View class="rounded-xl border border-border-60 bg-card-40" accessibilityLabel="Authorized clients section">
      <View class="min-h-11 flex-row flex-wrap items-center gap-x-4 px-4">
        <View class="min-h-11 min-w-0 flex-1 flex-row items-center gap-2 py-2" role="button" accessibilityLabel="Authorized clients" onPress={() => open.set(!open())}>
          <View class={open() ? "rotate-90" : ""}><SettingsIcon name="chevron-right" size={16} /></View>
          <Text class="text-sm font-medium text-foreground">Authorized clients</Text>
          <Text class="min-w-0 truncate text-xs text-muted-foreground">{summarizeAuthorizedClients(sessions(), links())}</Text>
        </View>
        {holds("access:write") ? <HeaderActions /> : null}
      </View>
      {!open() && holds("access:read") && newest() ? <View class="border-t border-border-50">{row(newest()!)}</View> : null}
      {open() ? (
        <View class="border-t border-border-50">
          {!holds("access:read") ? (
            <Text class="px-4 py-3 text-xs text-muted-foreground">This connection can create access links but cannot view authorized clients.</Text>
          ) : (
            <>
              {accessState().error ? <Text class="px-4 py-3 text-xs text-destructive-foreground">{accessState().error}</Text> : null}
              <Each of={links()} key={(link) => link.id}>{(link) => <View>{row(link())}<View class="h-px bg-border-50" /></View>}</Each>
              <Each of={sessions()} key={(session) => session.sessionId}>
                {(session) => (
                  <View>
                    <ConnectedClientRow
                      session={session()}
                      now={now()}
                      revoking={revoking() === session().sessionId}
                      canRevoke={holds("access:write")}
                      onRevoke={() => void guarded(session().sessionId, () => revokeClientSession(session().sessionId), { title: "Could not revoke client access", fallback: "Failed to revoke client access." })}
                    />
                    <View class="h-px bg-border-50" />
                  </View>
                )}
              </Each>
              {links().length === 0 && sessions().length === 0 && accessState().loaded ? (
                <View class="px-4 py-3"><Text class="text-xs text-muted-foreground-70">No pairing links or client sessions.</Text></View>
              ) : null}
            </>
          )}
        </View>
      ) : null}
      {problem() && !createOpen() ? <Text class="px-4 pb-3 text-xs text-destructive-foreground">{problem()}</Text> : null}
    </View>
  );
}

/** SessionPermissions: what the connected session may do, read from `GET /api/auth/session`. */
function SessionPermissions() {
  const session = () => accessSession();
  const known = () => backendStatus() === "connected" && session().status === "ready" && session().authenticated;
  return known() ? (
    <View class="gap-3 py-3">
      <Text class="text-xs text-muted-foreground">These permissions apply to this client’s current connection.</Text>
      <View class="flex-row flex-wrap gap-x-6 gap-y-2">
        {PAIRING_SCOPE_OPTIONS.map((option) => (
          <View class="w-[45%] flex-row items-start justify-between gap-3">
            <Text class="text-xs text-foreground">{option.title}</Text>
            <Text class="shrink-0 text-xs text-muted-foreground">{sessionHolds(session(), option.scope) ? "Allowed" : "Not granted"}</Text>
          </View>
        ))}
      </View>
    </View>
  ) : (
    <Text class="py-3 text-xs text-muted-foreground">
      {sessionPermissionsUnavailableMessage({ connected: backendStatus() === "connected", failed: session().status === "failed", rejected: session().status === "ready" && !session().authenticated })}
    </Text>
  );
}

/** renderDisabledNetworkAccessRow: this client cannot change exposure; it says what the server's auth policy implies. */
function NetworkAccessRow() {
  const copy = () => networkAccessWithoutBridge(accessSession().policy);
  const control = () => copy().showSwitch ? (
    <View tooltip={<Tip label={NETWORK_ACCESS_TOOLTIP} />} class="opacity-50" style={{ pointerEvents: "none" }}>
      <SettingsSwitch label="Enable network access" checked={copy().on} onChange={() => {}} />
    </View>
  ) : null;
  return <SettingsRow title="Network access" description={copy().description} control={control()} />;
}

function PreviewTunnelRow() {
  const env = () => serverEnvironment();
  const capabilities = () => (env()?.capabilities ?? null) as Record<string, unknown> | null;
  const shown = () => capabilities()?.previewTunnelSetting === true;
  const policy = () => serverManagedPolicy();
  const denial = () => {
    const cap = managedCapabilityDenial(policy(), "previewTunnel");
    if (cap !== undefined) return cap;
    const org = managedSettingLock(policy(), "enablePreviewTunnel");
    return org !== undefined ? `Managed by ${org}.` : undefined;
  };
  const checked = () => denial() === undefined && serverSettings()?.enablePreviewTunnel !== false;
  const busy = signal(false);
  const toggle = async (next: boolean) => {
    if (busy() || !holds("access:write") || denial() !== undefined) return;
    busy.set(true);
    try {
      replaceServerSettings(await requestServer("server.updateSettings", { patch: { enablePreviewTunnel: next } }));
    } catch (error) {
      showToast({ type: "error", title: "Could not update preview tunnel", description: error instanceof Error ? error.message : String(error) });
    } finally {
      busy.set(false);
    }
  };
  return () => shown() ? (
    <SearchAnchor path="/settings/access" id="preview-tunnel">
      <View class="h-px bg-border-50" />
      <SettingsRow
        title="Preview tunnel"
        description="Lets other devices open this machine's local servers: browser tabs loaded on the device, Open on this device, and port forwarding. Off: browser tabs stream from this machine."
        managed={denial()}
        control={
          <SettingsSwitch
            label="Allow the preview tunnel"
            checked={checked()}
            disabled={!holds("access:write") || denial() !== undefined || busy()}
            onChange={(next) => void toggle(next)}
          />
        }
      />
    </SearchAnchor>
  ) : null;
}

function VersionRow() {
  const isR3RustServer = () => localServerEngine() === "r3";
  const serverVersion = () => { const value = serverEnvironment()?.serverVersion; return typeof value === "string" ? value : null; };
  const address = () => { try { return new URL(backendUrl()).host; } catch { return backendUrl() || null; } };
  const description = () => [isR3RustServer() ? (serverVersion() ? `R3 Rust · ${serverVersion()}` : "R3 Rust") : serverVersion(), address()].filter((part): part is string => part !== null && part !== "").join(" · ") || "Loading…";
  // With matching versions the web's passive label follows the desktop updater, which is null outside the desktop shell: "Up to date".
  const mismatch = () => (!isR3RustServer() && backendStatus() === "connected" ? resolveVersionMismatch(serverVersion()) : null);
  return (
    <SettingsRow
      title="Version"
      description={description()}
      control={mismatch() ? <Text class="text-xs text-muted-foreground">{`Update available: ${mismatch()!.serverVersion} → ${mismatch()!.clientVersion}`}</Text> : serverVersion() !== null ? <Text class="text-xs text-muted-foreground">Up to date</Text> : null}
    />
  );
}

function MachineActions() {
  const config = () => ({ environment: serverEnvironment(), settings: serverSettings() });
  const operateAccess = (): "granted" | "denied" | "pending" => (accessSession().status === "ready" ? (sessionHolds(accessSession(), "settings:write") ? "granted" : "denied") : "pending");
  return (
    <Menu
      popupClass="min-w-44 rounded-lg border border-border bg-popover-84 p-1"
      align="end"
      trigger={
        <View role="button" accessibilityLabel="More actions for this machine" class="size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out">
          <SettingsIcon name="ellipsis" size={14} />
        </View>
      }
    >
      <EnvironmentIconMenu config={backendStatus() === "connected" ? config() : null} operateAccess={operateAccess()} />
    </Menu>
  );
}

export function AccessSettings() {
  const connected = () => backendStatus() === "connected";
  effect(() => {
    // Follow the list while the page is up and the environment is connected.
    if (!connected()) return;
    backendUrl();
    const stop = watchAccess();
    void loadAccessSession();
    const timer = setInterval(() => now.set(Date.now()), 1000);
    return () => { stop(); clearInterval(timer); };
  });
  const environmentLabel = () => {
    const value = serverEnvironment()?.label;
    return typeof value === "string" && value.length > 0 ? value : "Primary environment";
  };
  const managed = () => { const policy = serverManagedPolicy(); const organization = policy?.organization; return typeof organization === "string" ? { organization, supportUrl: typeof policy?.supportUrl === "string" ? (policy.supportUrl as string) : undefined } : null; };
  // canManageLocalBackend: this is the primary environment, its local server is on, and the session may maintain it.
  const manageLocal = () => localEnvironmentEnabled() && holds("environment:maintain");
  return (
    <>
      {backendUrl() ? (
        <>
          <SettingsSection
            title={environmentLabel()}
            icon={<MachineIcon kind={resolveEnvironmentMachineKind(connected() ? { environment: serverEnvironment(), settings: serverSettings() } : null)} size={16} />}
            headerAction={<MachineActions />}
          >
            {managed() ? <View class="px-4 py-2"><ManagedByOrganization organization={managed()!.organization} supportUrl={managed()!.supportUrl} /></View> : null}
            {manageLocal() ? <VersionRow /> : null}
            {manageLocal() ? (networkAccessAvailable() ? <NetworkAccessRows /> : <><View class="h-px bg-border-50" /><NetworkAccessRow /></>) : null}
            {holds("relay:read") || holds("relay:write") ? <CloudLinkRow environmentId={() => { const id = serverEnvironment()?.environmentId; return typeof id === "string" ? id : null; }} canReadRelay={holds("relay:read")} canManageRelay={holds("relay:write")} /> : null}
            <PreviewTunnelRow />
            <View class="h-px bg-border-50" />
            <View class="px-4">
              <View class="min-h-11 flex-row items-center gap-2 py-2" role="button" accessibilityLabel="Permissions" onPress={() => permissionsOpen.set(!permissionsOpen())}>
                <Text class="text-sm font-medium text-foreground">Permissions</Text>
                <View class={permissionsOpen() ? "rotate-90" : ""}><SettingsIcon name="chevron-right" size={12} /></View>
              </View>
              {permissionsOpen() ? <SessionPermissions /> : null}
            </View>
          </SettingsSection>
          {holds("access:read") || holds("access:write") ? <AuthorizedClients /> : null}
          <CreateLinkDialog />
        </>
      ) : (
        <SettingsSection title="">
          <SettingsRow title="No environment selected" description="Connect an environment to view its settings and access." />
        </SettingsSection>
      )}
    </>
  );
}

