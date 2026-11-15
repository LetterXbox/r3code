// The Source control panel's discovery sections, ported from SourceControlSettings.tsx:
// "Version Control" and "Source control providers" listing what the server found
// (`server.discoverSourceControl`), a rescan button, and the empty, error and
// disconnected states. Provider credential and host settings (the web's expandable
// per-provider forms) are not part of this port yet.
import { registerSettingsRow } from "./settingsSearchNav";
import { effect, signal, Text, untracked, View } from "nsh";
import { SettingsSection } from "../../components/SettingsLayout";
import { SettingsIcon } from "./SettingsIcon";
import { RedactedSensitiveText } from "./providers/RedactedText";
import { HIcon } from "../../components/header/HeaderIcons";
import { ChevronTurn } from "../../components/motion/Motion";
import { tokenAlpha } from "../../components/composer/tokenColor";
import { isServerConnected, requestServer } from "./settingsSync";
import { CREDENTIAL_PROVIDERS, type DiscoveredAccount } from "./sourceControlAccounts";
import { SourceControlAccountSettings, SourceControlTokenSettings } from "./SourceControlCredentials";
import { SourceControlAppSignIn } from "./SourceControlAppSignIn";
import { SourceControlHostSettings } from "./SourceControlHostSettings";
import { APP_SIGN_INS } from "./sourceControlSignIn";
import { HOST_SETTINGS } from "./sourceControlHosts";

type Dict = Record<string, unknown>;

export interface DiscoveryItem {
  provider: boolean;
  kind: string;
  label: string;
  status: string;
  version: string | null;
  installHint: string;
  executable: string | null;
  implemented: boolean;
  /** The provider offers sign-in through its forge app (`appSignIn` of SourceControlProviderDiscoveryItem). */
  appSignIn: boolean;
  auth: { status: string; account: string | null; detail: string | null; accounts: DiscoveredAccount[] } | null;
}

export interface Discovery { versionControlSystems: DiscoveryItem[]; sourceControlProviders: DiscoveryItem[] }

const dict = (value: unknown): Dict | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dict) : null);

/** An effect Option over the wire: a bare value, null, or `{ _tag: "Some" | "None", value }`. */
export function optionValue(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  const tagged = dict(value);
  if (tagged?._tag === "Some" && typeof tagged.value === "string") return tagged.value;
  return null;
}

function parseAccounts(value: unknown): DiscoveredAccount[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const entry = dict(raw);
    if (!entry || typeof entry.host !== "string" || typeof entry.account !== "string") return [];
    return [{
      host: entry.host, account: entry.account, active: entry.active === true, authenticated: entry.authenticated === true,
      ...(typeof entry.error === "string" ? { error: entry.error } : {}),
      ...(typeof entry.environmentVariable === "string" ? { environmentVariable: entry.environmentVariable } : {}),
    }];
  });
}

function parseItem(raw: unknown, provider: boolean): DiscoveryItem | null {
  const item = dict(raw);
  if (!item || typeof item.kind !== "string" || typeof item.label !== "string") return null;
  const auth = dict(item.auth);
  return {
    provider,
    kind: item.kind,
    label: item.label,
    status: typeof item.status === "string" ? item.status : "missing",
    version: optionValue(item.version),
    installHint: typeof item.installHint === "string" ? item.installHint : "",
    executable: typeof item.executable === "string" ? item.executable : null,
    implemented: item.implemented !== false,
    appSignIn: item.appSignIn === true,
    auth: provider && auth ? { status: String(auth.status ?? "unknown"), account: optionValue(auth.account), detail: optionValue(auth.detail), accounts: parseAccounts(auth.accounts) } : null,
  };
}

export function parseDiscovery(value: unknown): Discovery {
  const result = dict(value);
  const list = (key: string, provider: boolean) => (Array.isArray(result?.[key]) ? (result![key] as unknown[]).flatMap((raw) => { const item = parseItem(raw, provider); return item ? [item] : []; }) : []);
  return { versionControlSystems: list("versionControlSystems", false), sourceControlProviders: list("sourceControlProviders", true) };
}

/** itemSummary: the line under an item's name (SourceControlSettings.tsx). */
export function itemSummary(item: DiscoveryItem): string {
  if (!item.provider && !item.implemented) return `Support for ${item.label} is coming soon.`;
  if (item.status !== "available") return `Not available on this server: ${item.installHint}`;
  const auth = item.auth;
  if (auth) {
    if (auth.status === "authenticated") return ["Authenticated", auth.account ? `as ${auth.account}` : null, auth.detail ? `· ${auth.detail}` : null].filter(Boolean).join(" ");
    if (!item.executable && auth.status === "unauthenticated") return `Available. ${item.installHint}`;
    if (auth.status === "unauthenticated" && auth.accounts.some((entry) => entry.authenticated)) return auth.detail ?? `Every ${item.label} host is turned off.`;
    if (auth.status === "unauthenticated") return `${item.label} is not authenticated on this server. Sign in or configure credentials using the ${item.executable} tool on the server host to enable change request features.`;
    return `Could not verify ${item.label}. ${auth.detail ?? item.installHint}`;
  }
  return "Available";
}

function enabled(item: DiscoveryItem): boolean {
  return item.provider ? item.status === "available" && item.auth?.status === "authenticated" : item.status === "available" && item.implemented;
}

const dotClass = (item: DiscoveryItem) => {
  if (!item.provider && !item.implemented) return "size-2 rounded-full bg-muted-foreground";
  if (item.provider) return item.status === "available" && item.auth?.status === "authenticated" ? "size-2 rounded-full bg-success" : "size-2 rounded-full bg-muted-foreground";
  return item.status !== "available" ? "size-2 rounded-full bg-warning" : "size-2 rounded-full bg-success";
};

// SourceControlSettings.tsx's `sourceControlItemIcon`/`VCS_ICONS`: each VCS/host's own brand mark
// (HeaderIcons.tsx's "own colours, never tinted" registry), by `item.kind`. A kind with no mark
// here (none currently) falls back to the plain status dot, as the reference does.
const ICON_NAME_BY_KIND: Record<string, string> = {
  git: "vcs-git",
  jj: "vcs-jujutsu",
  github: "github",
  gitlab: "host-gitlab",
  bitbucket: "host-bitbucket",
  "azure-devops": "host-azure-devops",
  forgejo: "host-forgejo",
  gitcafe: "host-gitcafe",
  "cursor-origin": "host-cursor-origin",
};

/** SourceControlSettings.tsx's `SourceControlItemMark`: the host/VCS brand mark (own colours) with
 * a small status-dot badge over its corner, or the plain dot alone when the kind has no mark. */
function ItemMark(props: { item: DiscoveryItem }) {
  const iconName = ICON_NAME_BY_KIND[props.item.kind];
  if (!iconName) return <View class={dotClass(props.item)} />;
  return (
    <View class="relative size-5 items-center justify-center">
      <HIcon name={iconName} size={18} />
      <View class={`absolute -left-0.5 -top-0.5 rounded-full border-2 border-background ${dotClass(props.item)}`} />
    </View>
  );
}

/** Which providers' details are open; kept here because a rescan rebuilds the rows. */
const expandedKinds = signal<string[]>([]);

function ItemRow(props: { item: DiscoveryItem; first: boolean }) {
  const item = props.item;
  const expanded = () => expandedKinds().includes(item.kind);
  // Only a provider whose definition has `credentials` has details (the web's hostSettingsPanel).
  const hasDetails = item.provider && isServerConnected() && (CREDENTIAL_PROVIDERS[item.kind] !== undefined || HOST_SETTINGS[item.kind] !== undefined);
  const withAppSignIn = item.appSignIn && APP_SIGN_INS[item.kind] !== undefined;
  // SourceControlSettings.tsx:235 `transition-colors hover:bg-muted/20` (alpha squared by NSH, so the tint is built from the token).
  const hovered = signal(false);
  return (
    <View
      class="transition-colors duration-150 ease-in-out"
      style={{ backgroundColor: hovered() ? tokenAlpha("muted", 0.2) : "transparent" }}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      testID={`Source control ${item.kind} (${enabled(item) ? "on" : "off"})`}
      ref={(node: any) => registerSettingsRow("/settings/source-control", `source-control-host-${item.kind}`, node)}
    >
      {!props.first ? <View class="h-px bg-border-50" /> : null}
      <View class="flex-row items-center justify-between gap-3 px-4 py-3">
        <View class="min-w-0 flex-1 gap-1">
          <View class="flex-row items-center gap-2">
            <ItemMark item={item} />
            <Text class="text-sm font-medium text-foreground">{item.label}</Text>
            {item.version ? <Text class="font-mono text-xs text-muted-foreground">{item.version}</Text> : null}
            {!item.provider && !item.implemented ? (
              <View class="h-4 min-w-4 items-center justify-center rounded border border-warning px-1"><Text class="text-3xs font-medium text-warning-foreground">Coming Soon</Text></View>
            ) : null}
            {item.auth?.status === "unauthenticated" && item.status === "available" ? (
              <View class="h-4 min-w-4 items-center justify-center rounded bg-secondary px-1"><Text class="text-3xs font-medium text-secondary-foreground">Not authenticated</Text></View>
            ) : null}
          </View>
          {item.status === "available" && item.auth?.status === "authenticated" && item.auth.account && (item.provider || item.implemented) ? (
            // SourceControlSettings.tsx itemSummary: the account is redacted until revealed (RedactedAccount).
            <View class="flex-row flex-wrap items-center gap-x-1">
              <Text class="text-xs leading-normal text-muted-foreground">Authenticated as</Text>
              <RedactedSensitiveText value={item.auth.account} ariaLabel="Toggle source control account visibility" revealTooltip="Click to reveal account" hideTooltip="Click to hide account" />
              {item.auth.detail ? <Text class="text-xs leading-normal text-muted-foreground">{`· ${item.auth.detail}`}</Text> : null}
            </View>
          ) : <Text class="text-xs leading-normal text-muted-foreground">{itemSummary(item)}</Text>}
        </View>
        <View class="shrink-0 flex-row items-center gap-2">
          {hasDetails ? (
            <View
              class="size-6 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
              accessibilityLabel={`Toggle ${item.label} details`}
              accessibilityState={{ expanded: expanded() }}
              onPress={() => expandedKinds.update((all) => (all.includes(item.kind) ? all.filter((kind) => kind !== item.kind) : [...all, item.kind]))}
            >
              <ChevronTurn open={expanded} degrees={180}><SettingsIcon name="chevron-down" size={14} /></ChevronTurn>
            </View>
          ) : null}
        </View>
      </View>
      {hasDetails && expanded() ? (
        <View class="gap-6 px-4 pb-4 pt-1">
          {CREDENTIAL_PROVIDERS[item.kind] ? (
            <>
              {withAppSignIn ? <SourceControlAppSignIn kind={item.kind} account={item.auth?.account ?? null} onChanged={() => void scanSourceControl()} /> : null}
              {withAppSignIn ? (
                <View class="flex-row items-center gap-3">
                  <View class="h-px flex-1 bg-border" />
                  <Text class="text-2xs text-muted-foreground">Or use your own credentials</Text>
                  <View class="h-px flex-1 bg-border" />
                </View>
              ) : null}
              <SourceControlTokenSettings kind={item.kind} onSaved={() => void scanSourceControl()} />
              {item.status === "available" ? <SourceControlAccountSettings kind={item.kind} accounts={item.auth?.accounts ?? []} onSaved={() => void scanSourceControl()} /> : null}
            </>
          ) : <SourceControlHostSettings kind={item.kind} onSaved={() => void scanSourceControl()} />}
        </View>
      ) : null}
    </View>
  );
}

const result = signal<Discovery | null>(null);
const pending = signal(false);
const failure = signal<string | null>(null);
let serial = 0;

export async function scanSourceControl(request: (method: string, payload: unknown) => Promise<unknown> = requestServer) {
  const mine = ++serial;
  pending.set(true);
  failure.set(null);
  try {
    const value = await request("server.discoverSourceControl", {});
    if (mine === serial) result.set(parseDiscovery(value));
  } catch (cause) {
    if (mine === serial) failure.set(cause instanceof Error ? cause.message : String(cause));
  } finally {
    if (mine === serial) pending.set(false);
  }
}

function RescanButton() {
  return (
    <View
      accessibilityLabel="Rescan server environment"
      tooltip="Rescan Git and hosting integrations"
      disabled={pending()}
      onPress={() => void scanSourceControl()}
      class={pending() ? "size-6 items-center justify-center rounded-lg opacity-50" : "size-6 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"}
    >
      <SettingsIcon name="rotate-ccw" size={14} />
    </View>
  );
}

export function SourceControlDiscovery() {
  effect(() => {
    if (isServerConnected()) void untracked(() => scanSourceControl());
    else { serial++; result.set(null); pending.set(false); failure.set(null); }
  });
  const found = () => result();
  const hasVcs = () => (found()?.versionControlSystems.length ?? 0) > 0;
  const hasProviders = () => (found()?.sourceControlProviders.length ?? 0) > 0;
  return (
    <>
      {!isServerConnected() ? (
        <SettingsSection title="Server environment">
          <View class="px-4 py-3"><Text class="text-sm text-muted-foreground">Connect an environment to inspect its version control tools and hosting integrations.</Text></View>
        </SettingsSection>
      ) : found() === null && pending() ? (
        <SettingsSection title="Version Control" headerAction={<RescanButton />}>
          <View class="px-4 py-3"><Text class="text-sm text-muted-foreground">Scanning the server environment...</Text></View>
        </SettingsSection>
      ) : hasVcs() || hasProviders() ? (
        <>
          {hasVcs() ? (
            <SettingsSection title="Version Control" headerAction={<RescanButton />}>
              <Each of={found()!.versionControlSystems} key={(item) => `vcs:${item.kind}`}>{(item, index) => <ItemRow item={item()} first={index() === 0} />}</Each>
            </SettingsSection>
          ) : null}
          {hasProviders() ? (
            <SettingsSection title="Source control providers" headerAction={hasVcs() ? null : <RescanButton />}>
              <Each of={found()!.sourceControlProviders} key={(item) => `provider:${item.kind}`}>{(item, index) => <ItemRow item={item()} first={index() === 0} />}</Each>
            </SettingsSection>
          ) : null}
        </>
      ) : (
        <SettingsSection title="Server environment">
          <View class="items-center gap-2 px-4 py-8">
            <Text class="text-sm font-medium text-foreground">{failure() ? "Could not scan the server environment" : "Nothing detected yet"}</Text>
            <Text class="text-center text-xs text-muted-foreground">{failure() ?? "Install Git on the server, add optional hosting integrations or credentials your workspace needs, then rescan."}</Text>
            <View accessibilityLabel="Scan" disabled={pending()} onPress={() => void scanSourceControl()} class="h-7 items-center justify-center rounded-lg border border-input bg-background px-3 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"><Text class="text-sm font-medium text-foreground">Scan</Text></View>
          </View>
        </SettingsSection>
      )}
    </>
  );
}
