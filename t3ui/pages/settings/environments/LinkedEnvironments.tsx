// LinkedEnvironmentsSettings.tsx: the connected environment's links to other machines (peerLinks.list / link / unlink),
// shown on Connections when the environment offers links (capabilities.peerLinks and its Linked environments beta).
// This client holds one live connection, so only that environment's links are listed. Not ported: the machine picker
// (useLinkableMachines over T3 Connect discovery) and minting a pairing code on a picked machine; the dialog always
// asks for an address and a pairing code, which is the reference's path for a machine this app does not know.
import { computed, effect, signal, Text, token, View } from "nsh";
import { record, stringifiedFailure } from "../../../backend/client";
import { scopeAllows } from "../../../backend/sessionScopes";
import { environmentConfigs, environmentConnections, requestEnvironment } from "../../../environments/connectionManager";
import { backendStatus, backendUrl, localServerEngine, requestBackend } from "../../../store";
import { SettingsButton, SettingsDivider, SettingsRow, SettingsSection, SettingsSelect } from "../../../components/SettingsLayout";
import { DialogField, SettingsDialog } from "../../../components/SettingsDialog";
import { DialogInput as Input } from "../../../components/DialogInput";
import { confirm, errorToast, showToast } from "../../../components/toast";
import { MCP_ACCESS_CONFIG, MCP_ACCESS_LEVELS, type McpClientAccess } from "../../../components/mcp/McpWizard";
import { SettingsIcon } from "../SettingsIcon";
import { SearchAnchor } from "../SearchAnchor";
import { savedEnvironments } from "./savedEnvironments";
import { serverEnvironment, serverSettings } from "../settingsState";

type Dict = Record<string, unknown>;

export interface PeerLinkSummary {
  environmentId: string;
  label: string;
  urls: string[];
  access: McpClientAccess;
  expiresAt: string;
  lastError: string | null;
  status: "reachable" | "unreachable" | "expired";
}

export type PeerLinkHealth =
  | { kind: "expired" }
  | { kind: "unreachable"; detail: string | null }
  | { kind: "failing"; detail: string }
  | { kind: "reachable"; expiresInDays: number | null };

const EXPIRY_WARNING_DAYS = 5;

/** client-runtime state/peerLinks.ts peerLinkHealth. */
export function peerLinkHealth(link: PeerLinkSummary, now: number): PeerLinkHealth {
  const expiresAt = Date.parse(link.expiresAt);
  if (link.status === "expired" || expiresAt <= now) return { kind: "expired" };
  if (link.status === "unreachable") return { kind: "unreachable", detail: link.lastError };
  if (link.lastError !== null) return { kind: "failing", detail: link.lastError };
  const days = Math.ceil((expiresAt - now) / 86_400_000);
  return { kind: "reachable", expiresInDays: days <= EXPIRY_WARNING_DAYS ? days : null };
}

export function peerLinkStatusText(health: PeerLinkHealth): string {
  return health.kind === "expired"
    ? "Expired. Link it again with a new pairing code."
    : health.kind === "unreachable"
      ? (health.detail ?? "Not answering right now.")
      : health.kind === "failing"
        ? health.detail
        : health.expiresInDays !== null
          ? `Expires in ${health.expiresInDays} ${health.expiresInDays === 1 ? "day" : "days"}. Link it again to renew.`
          : "Reachable";
}

function dotClass(health: PeerLinkHealth): string {
  return health.kind === "reachable"
    ? health.expiresInDays === null ? "bg-success" : "bg-warning"
    : health.kind === "expired" || health.kind === "failing" ? "bg-destructive" : "bg-muted-foreground";
}

/** offersLinkedEnvironments (client-runtime linkRequest.ts). */
export function offersLinkedEnvironments(environment: Dict | null, settings: Dict | null): boolean {
  const capabilities = environment?.capabilities as Dict | undefined;
  return capabilities?.peerLinks === true && settings?.linkedEnvironmentsEnabled === true;
}

function parseLink(value: unknown): PeerLinkSummary | null {
  const item = value as Dict | null;
  if (!item || typeof item.environmentId !== "string" || typeof item.label !== "string") return null;
  return {
    environmentId: item.environmentId,
    label: item.label,
    urls: Array.isArray(item.urls) ? item.urls.filter((url): url is string => typeof url === "string") : [],
    access: (MCP_ACCESS_LEVELS as readonly string[]).includes(item.access as string) ? (item.access as McpClientAccess) : "approval-required",
    expiresAt: typeof item.expiresAt === "string" ? item.expiresAt : new Date(0).toISOString(),
    lastError: typeof item.lastError === "string" ? item.lastError : null,
    status: item.status === "unreachable" || item.status === "expired" ? item.status : "reachable",
  };
}

type Request = (method: string, payload: unknown) => Promise<unknown>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function LinkedEnvironmentsSettings(props: { request?: Request; environmentLabel?: string | null | (() => string | null) }) {
  const request: Request = props.request ?? ((method, payload) => requestBackend(method, payload));
  const links = signal<PeerLinkSummary[] | null>(null);
  const error = signal<string | null>(null);
  const now = signal(Date.now());
  const reload = async () => {
    try {
      const result = (await request("peerLinks.list", {})) as Dict | null;
      links.set(Array.isArray(result?.links) ? result!.links.map(parseLink).filter((link): link is PeerLinkSummary => link !== null) : []);
      error.set(null);
    } catch (cause) {
      error.set(errorMessage(cause));
    }
    now.set(Date.now());
  };
  void reload();
  effect(() => {
    const timer = setInterval(() => now.set(Date.now()), 60_000);
    return () => clearInterval(timer);
  });
  const envLabel = () => (typeof props.environmentLabel === "function" ? props.environmentLabel() : props.environmentLabel);
  const title = () => (envLabel() ? `Linked environments · ${envLabel()}` : "Linked environments");
  return (
    <SettingsSection title={title()} headerAction={<LinkEnvironmentAction request={request} onLinked={reload} />}>
      {error() ? (
        <SettingsRow title="Could not load linked environments" description={error()!} />
      ) : links() === null ? (
        <SettingsRow title="Loading linked environments…" />
      ) : links()!.length === 0 ? (
        <SettingsRow title="No linked environments" description="Link another machine running T3 Code, such as a VPS, so agents here can launch and drive threads there." />
      ) : (
        <Each of={links()!} key={(link) => link.environmentId}>
          {(link, index) => (
            <View>
              {index() > 0 ? <SettingsDivider /> : null}
              <LinkedEnvironmentRow link={link()} now={now} request={request} onChanged={reload} />
            </View>
          )}
        </Each>
      )}
    </SettingsSection>
  );
}

function LinkedEnvironmentRow(props: { link: PeerLinkSummary; now: () => number; request: Request; onChanged: () => Promise<void> }) {
  const busy = signal(false);
  const health = () => peerLinkHealth(props.link, props.now());
  const status = () => peerLinkStatusText(health());
  const forget = async () => {
    const link = props.link;
    const confirmed = await confirm(
      `Forget ${link.label}? Agents here stop working there. Revoke "T3 Code · …" in ${link.label}'s Connections to end the session there too.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    busy.set(true);
    try {
      await props.request("peerLinks.unlink", { environmentId: link.environmentId });
      await props.onChanged();
    } catch (cause) {
      errorToast("Could not forget the link", stringifiedFailure(cause));
    } finally {
      busy.set(false);
    }
  };
  return (
    <View class="flex-row items-center gap-4 px-4 py-3" testID={`Linked environment ${props.link.label}`}>
      <View class="min-w-0 flex-1 gap-1">
        <View class="min-h-5 flex-row items-center gap-1.5">
          <View class="size-3 shrink-0 items-center justify-center" accessibilityLabel={status()} tooltip={status()}>
            <View class={`size-2 rounded-full ${dotClass(health())}`} style={health().kind === "unreachable" ? { opacity: 0.3 } : undefined} />
          </View>
          <Text class="text-sm font-medium text-foreground">{props.link.label}</Text>
        </View>
        <Text class="text-xs text-muted-foreground">{`${MCP_ACCESS_CONFIG[props.link.access].label} · ${status()}`}</Text>
        <Text class="truncate text-xs text-muted-foreground-80">{props.link.urls.join(", ")}</Text>
      </View>
      <SettingsButton label={busy() ? "Forgetting…" : "Forget"} accessibilityLabel={`Forget ${props.link.label}`} tone="destructive" disabled={busy()} onPress={() => void forget()} />
    </View>
  );
}

function LinkEnvironmentAction(props: { request: Request; onLinked: () => Promise<void> }) {
  const open = signal(false);
  const address = signal("");
  const pairingCode = signal("");
  const access = signal<McpClientAccess>("approval-required");
  const busy = signal(false);
  let inFlight = false;
  const ready = () => address().trim().length > 0 && pairingCode().trim().length > 0;
  const close = () => {
    if (busy()) return;
    open.set(false);
    address.set("");
    pairingCode.set("");
    access.set("approval-required");
  };
  const submit = async () => {
    if (inFlight || !ready()) return;
    inFlight = true;
    busy.set(true);
    try {
      const result = (await props.request("peerLinks.link", { url: address().trim(), pairingCode: pairingCode().trim(), access: access() })) as Dict | null;
      busy.set(false);
      showToast({ type: "success", title: `Linked ${typeof result?.label === "string" ? result.label : address().trim()}` });
      close();
      await props.onLinked();
    } catch (cause) {
      errorToast("Could not link the environment", stringifiedFailure(cause));
    } finally {
      inFlight = false;
      busy.set(false);
    }
  };
  return (
    <>
      <View
        role="button"
        accessibilityLabel="Link"
        onPress={() => open.set(true)}
        class="h-6 flex-row items-center gap-1 rounded-md bg-primary px-2 active:scale-[0.97] transition-transform duration-150 ease-in-out"
      >
        <SettingsIcon name="plus" size={12} tint={token("primary-foreground")} />
        <Text class="text-xs font-medium text-primary-foreground">Link</Text>
      </View>
      <SettingsDialog
        open={open()}
        onClose={close}
        title="Link an environment"
        description="Agents here can then launch, message and wait on threads there. It appears in that environment's Connections, where it can be revoked."
        width={448}
        testID="Link an environment dialog"
        footer={
          <>
            <SettingsButton label="Cancel" disabled={busy()} onPress={close} />
            <SettingsButton label={busy() ? "Linking…" : "Link"} accessibilityLabel="Confirm link" tone="primary" disabled={busy() || !ready()} onPress={() => void submit()} />
          </>
        }
      >
        <View class="gap-4">
          <DialogField label="Address">
            <Input
              accessibilityLabel="Address"
              value={address()}
              placeholder="https://box.example.ts.net"
              autoCapitalize="none"
              autoCorrect={false}
              disabled={busy()}
              onChange={(event) => address.set(event.value)}
              onSubmit={() => void submit()}
              class="h-8 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground"
            />
          </DialogField>
          <DialogField label="Pairing code">
            <Input
              accessibilityLabel="Pairing code"
              value={pairingCode()}
              placeholder="From that environment's Connections, or t3 pair there"
              autoCapitalize="none"
              autoCorrect={false}
              disabled={busy()}
              onChange={(event) => pairingCode.set(event.value)}
              onSubmit={() => void submit()}
              class="h-8 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground"
            />
          </DialogField>
          <View class="gap-1.5">
            <Text class="text-xs font-medium text-foreground">What agents here may do there</Text>
            <SettingsSelect inline
              label="What agents here may do there"
              value={access()}
              options={MCP_ACCESS_LEVELS.map((option) => ({ value: option, label: MCP_ACCESS_CONFIG[option].label, description: MCP_ACCESS_CONFIG[option].description }))}
              onChange={(next) => access.set(next as McpClientAccess)}
            />
            <Text class="text-xs text-muted-foreground">
              {`${MCP_ACCESS_CONFIG[access()].description} An agent never gets more access there than its own mode here. Below full access, it can change only threads this link started, not that machine's own threads, projects or settings.`}
            </Text>
          </View>
        </View>
      </SettingsDialog>
    </>
  );
}

export interface PeerLinkHost {
  key: string;
  label: string;
  request: Request;
}

function primaryEnvironmentLabel(): string {
  const value = serverEnvironment()?.label;
  if (localServerEngine() === "r3" && (typeof value !== "string" || value.length === 0 || value === "T3 Code")) {
    return "R3 Code";
  }
  return typeof value === "string" && value.length > 0 ? value : "Primary environment";
}

/** Every connected environment (primary and saved remotes) offering linked environments. */
export function connectedPeerLinkHosts(): PeerLinkHost[] {
  const hosts: PeerLinkHost[] = [];
  if (backendStatus() === "connected" && scopeAllows("access:read") && offersLinkedEnvironments(serverEnvironment(), serverSettings())) {
    hosts.push({
      key: "primary",
      label: primaryEnvironmentLabel(),
      request: (method, payload) => requestBackend(method, payload),
    });
  }
  const primaryUrl = backendUrl();
  const connections = environmentConnections();
  const configs = environmentConfigs();
  for (const env of savedEnvironments()) {
    if (!env.enabled || env.url === primaryUrl || connections[env.id]?.phase !== "connected") continue;
    const config = record(configs[env.id]);
    const environment = record(config?.environment);
    const settings = record(config?.settings);
    if (!offersLinkedEnvironments(environment, settings)) continue;
    const fallbackLabel = typeof environment?.label === "string" && environment.label.length > 0 ? environment.label : env.url;
    hosts.push({
      key: env.id,
      label: env.label || fallbackLabel,
      request: (method, payload) => requestEnvironment(env.id, method, payload),
    });
  }
  return hosts;
}

/** ConnectionsSettings: one Linked environments section per connected environment that offers links (primary + saved remotes). */
export function LinkedEnvironmentsHost() {
  const hosts = computed(() => connectedPeerLinkHosts());
  const hasHosts = computed(() => hosts().length > 0);
  return hasHosts() ? (
    <SearchAnchor path="/settings/connections" id="linked-environments">
      <View class="gap-8">
        <Each of={hosts()} key={(host) => host.key}>
          {(host) => (
            <LinkedEnvironmentsSettings
              request={(method, payload) => host().request(method, payload)}
              environmentLabel={() => (hosts().length > 1 ? host().label : null)}
            />
          )}
        </Each>
      </View>
    </SearchAnchor>
  ) : null;
}
