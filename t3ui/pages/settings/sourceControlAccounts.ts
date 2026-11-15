// Credential and account logic of the Source control panel's provider details, ported from
// SourceControlAccountSettings.logic.ts, SourceControlTokenSettings.tsx and the `credentials` of the
// built-in definitions (packages/source-control-github/src/shared/definition.ts: only GitHub has them).
type Dict = Record<string, unknown>;

export interface HostCredentials {
  cliName: string;
  cliLabel: string;
  loginCommand: string;
  tokenEnvVar: string;
  tokenAccess: string;
  newTokenUrl: (host: string) => string;
}

export interface ProviderCredentialDefinition {
  label: string;
  publicHost: string | null;
  credentials: HostCredentials;
}

/** Built-in definitions that carry `credentials`. */
export const CREDENTIAL_PROVIDERS: Record<string, ProviderCredentialDefinition> = {
  github: {
    label: "GitHub",
    publicHost: "github.com",
    credentials: {
      cliName: "gh",
      cliLabel: "GitHub CLI",
      loginCommand: "gh auth login",
      tokenEnvVar: "GH_TOKEN",
      tokenAccess: "read and write access to pull requests and contents",
      newTokenUrl: (host) => `https://${host}/settings/personal-access-tokens/new`,
    },
  },
};

export interface DiscoveredAccount {
  host: string;
  account: string;
  active: boolean;
  authenticated: boolean;
  error?: string;
  environmentVariable?: string;
}

export interface HostAccountGroup {
  host: string;
  activeAccount: string | null;
  selectable: string[];
  broken: DiscoveredAccount[];
  environmentVariable: string | null;
}

export function groupHostAccounts(accounts: readonly DiscoveredAccount[]): HostAccountGroup[] {
  const hosts = [...new Set(accounts.map((entry) => entry.host))];
  return hosts.map((host) => {
    const entries = accounts.filter((entry) => entry.host === host);
    const stored = entries.filter((entry) => entry.environmentVariable === undefined);
    const selectable = stored.filter((entry) => entry.authenticated);
    return {
      host,
      activeAccount: (selectable.find((entry) => entry.active) ?? selectable[0])?.account ?? null,
      selectable: selectable.map((entry) => entry.account),
      broken: stored.filter((entry) => !entry.authenticated),
      environmentVariable: entries.find((entry) => entry.environmentVariable)?.environmentVariable ?? null,
    };
  });
}

export interface HostAccountChoice { account?: string; enabled: boolean }

export function nextHostAccountChoices(
  current: Record<string, HostAccountChoice>,
  host: string,
  change: { enabled?: boolean; account?: string | null },
): Record<string, HostAccountChoice> {
  const previous = current[host];
  const enabled = change.enabled ?? previous?.enabled ?? true;
  const account = change.account === undefined ? previous?.account : (change.account ?? undefined);
  const { [host]: _replaced, ...rest } = current;
  if (enabled && account === undefined) return rest;
  return { ...rest, [host]: { enabled, ...(account === undefined ? {} : { account }) } };
}

/** The saved per-hostname choices and tokens of a host (readHostCredentialSettings). */
export function readHostCredentialSettings(settings: Dict | null, kind: string): { hosts: Record<string, HostAccountChoice>; tokens: Record<string, unknown> } {
  const all = settings?.sourceControlHosts as Dict | undefined;
  const mine = all?.[kind] as Dict | undefined;
  const hostsRaw = (mine?.hosts ?? {}) as Dict;
  const hosts: Record<string, HostAccountChoice> = {};
  for (const [host, value] of Object.entries(hostsRaw)) {
    const choice = value as Dict | null;
    if (!choice || typeof choice !== "object") continue;
    hosts[host] = { enabled: choice.enabled !== false, ...(typeof choice.account === "string" ? { account: choice.account } : {}) };
  }
  const tokens = (mine?.tokens && typeof mine.tokens === "object" ? mine.tokens : {}) as Record<string, unknown>;
  return { hosts, tokens };
}

/** A saved token is a non-empty string (a redaction marker) or a secret reference. */
export const hasToken = (token: unknown) => (typeof token === "string" ? token.length > 0 : token !== undefined && token !== null);

/** The `server.updateSettings` patch that saves (or, with "", removes) one host's token; the whole map goes, as other tokens' redaction markers keep their values. */
export function tokenPatch(kind: string, tokens: Record<string, unknown>, host: string, token: string) {
  return { sourceControlHosts: { [kind]: { tokens: { ...tokens, [host]: token } } } };
}

/** The patch that saves the account choices of one provider. */
export function accountPatch(kind: string, hosts: Record<string, HostAccountChoice>) {
  return { sourceControlHosts: { [kind]: { hosts } } };
}
