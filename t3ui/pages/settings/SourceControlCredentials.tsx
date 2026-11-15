// A provider's expanded details in the Source control panel: the personal access token form and the
// per-host account choices (SourceControlTokenSettings.tsx, SourceControlAccountSettings.tsx). The
// forge-app sign-in and the settings forms of providers without `credentials` are not ported.
import { openUrl, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { SettingsButton, SettingsSelect, SettingsSwitch } from "../../components/SettingsLayout";
import { RedactedSensitiveText } from "./providers/RedactedText";
import { SettingsIcon } from "./SettingsIcon";
import { replaceServerSettings, serverSettings } from "./settingsState";
import { requestServer } from "./settingsSync";
import {
  CREDENTIAL_PROVIDERS, accountPatch, groupHostAccounts, hasToken, nextHostAccountChoices, readHostCredentialSettings, tokenPatch,
  type DiscoveredAccount,
} from "./sourceControlAccounts";

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const ACTIVE_ACCOUNT = "active cli account";

function Code(props: { children: any }) {
  return <Text class="rounded bg-muted px-1 font-mono text-2xs text-foreground">{props.children}</Text>;
}

export function SourceControlTokenSettings(props: { kind: string; onSaved: () => void }) {
  const definition = CREDENTIAL_PROVIDERS[props.kind]!;
  const { credentials } = definition;
  const defaultHost = definition.publicHost ?? "";
  const host = signal(defaultHost);
  const draft = signal("");
  const saving = signal(false);
  const error = signal("");
  const saved = () => readHostCredentialSettings(serverSettings(), props.kind);
  const normalizedHost = () => host().trim().toLowerCase();
  const isSaved = () => hasToken(saved().tokens[normalizedHost()]);
  const savedHosts = () => Object.entries(saved().tokens).filter(([, value]) => hasToken(value)).map(([name]) => name);
  const submission = () => draft().trim();
  const save = async (target: string, token: string) => {
    saving.set(true);
    error.set("");
    try {
      replaceServerSettings(await requestServer("server.updateSettings", { patch: tokenPatch(props.kind, saved().tokens, target, token) }));
      draft.set("");
      props.onSaved();
    } catch (cause) {
      error.set(message(cause));
    } finally {
      saving.set(false);
    }
  };
  const field = "h-6.5 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground";
  return (
    <View class="gap-3" testID={`${definition.label} token settings`}>
      <View class="max-w-2xl flex-row flex-wrap items-center gap-x-1">
        <Text class="text-xs leading-relaxed text-muted-foreground">A token saved here is used before</Text>
        <Code>{credentials.tokenEnvVar}</Code>
        <Text class="text-xs leading-relaxed text-muted-foreground">and the</Text>
        <Code>{credentials.cliName}</Code>
        <Text class="text-xs leading-relaxed text-muted-foreground">{`login, so ${definition.label} works without the ${credentials.cliLabel}. Give it ${credentials.tokenAccess}.`}</Text>
        {normalizedHost() || defaultHost ? (
          <View
            accessibilityLabel="Create a token"
            class="flex-row items-center gap-1"
            onPress={() => void openUrl(credentials.newTokenUrl(normalizedHost() || defaultHost)).catch(() => undefined)}
          >
            <Text class="text-xs text-foreground underline">Create a token</Text>
            <SettingsIcon name="external-link" size={12} />
          </View>
        ) : null}
      </View>
      <View class="flex-row gap-3">
        <View class="w-48 gap-1.5">
          <Text class="text-xs font-medium text-foreground">Host</Text>
          <Input value={host()} placeholder={defaultHost} accessibilityLabel={`${definition.label} token host`} onChange={(e: { value: string }) => host.set(e.value)} class={field} />
        </View>
        <View class="min-w-0 flex-1 gap-1.5">
          <Text class="text-xs font-medium text-foreground">Token</Text>
          <Input
            value={draft()}
            masked
            placeholder={isSaved() ? "Saved. Enter a new token to replace it." : ""}
            accessibilityLabel={`${definition.label} token`}
            onChange={(e: { value: string }) => draft.set(e.value)}
            onSubmit={() => { if (normalizedHost() && submission() !== "") void save(normalizedHost(), submission()); }}
            class={field}
          />
        </View>
      </View>
      <View class="flex-row items-center justify-between gap-3">
        <Text class="min-w-0 flex-1 text-xs text-muted-foreground">
          {savedHosts().length === 0
            ? `No token saved; the server uses ${credentials.tokenEnvVar} or the ${credentials.cliName} login.`
            : `Saved for ${savedHosts().join(", ")}.`}
        </Text>
        <View class="shrink-0 flex-row gap-2">
          {isSaved() ? <SettingsButton label="Remove" accessibilityLabel={`Remove ${definition.label} token`} disabled={saving()} onPress={() => void save(normalizedHost(), "")} /> : null}
          <SettingsButton label="Save" accessibilityLabel={`Save ${definition.label} token`} disabled={!normalizedHost() || submission() === "" || saving()} onPress={() => void save(normalizedHost(), submission())} />
        </View>
      </View>
      {error() ? <Text class="text-xs text-destructive-foreground">{error()}</Text> : null}
    </View>
  );
}

function Login(props: { account: string; revealed: () => boolean }) {
  return props.revealed()
    ? <Text class="font-mono text-2xs text-foreground">{props.account}</Text>
    : <RedactedSensitiveText value={props.account} ariaLabel="Toggle account visibility" revealTooltip="Click to reveal account" hideTooltip="Click to hide account" />;
}

export function SourceControlAccountSettings(props: { kind: string; accounts: DiscoveredAccount[]; onSaved: () => void }) {
  const definition = CREDENTIAL_PROVIDERS[props.kind]!;
  const { credentials, label } = { credentials: definition.credentials, label: definition.label };
  const saving = signal(false);
  const revealed = signal(false);
  const error = signal("");
  const groups = () => groupHostAccounts(props.accounts);
  const hosts = () => readHostCredentialSettings(serverSettings(), props.kind).hosts;
  const save = async (host: string, change: { enabled?: boolean; account?: string | null }) => {
    saving.set(true);
    error.set("");
    try {
      replaceServerSettings(await requestServer("server.updateSettings", { patch: accountPatch(props.kind, nextHostAccountChoices(hosts(), host, change)) }));
      props.onSaved();
    } catch (cause) {
      error.set(message(cause));
    } finally {
      saving.set(false);
    }
  };
  if (groups().length === 0) {
    return (
      <View class="flex-row flex-wrap items-center gap-x-1">
        <Text class="text-xs text-muted-foreground">Sign in with</Text>
        <Code>{credentials.loginCommand}</Code>
        <Text class="text-xs text-muted-foreground">on the server host, then rescan to choose accounts here.</Text>
      </View>
    );
  }
  return (
    <View class="gap-4" testID={`${label} account settings`}>
      <View class="flex-row items-center justify-between gap-3">
        <Text class="max-w-2xl text-xs leading-relaxed text-muted-foreground">{`Choose which ${credentials.cliName} login each ${label} host uses, or turn a host off.`}</Text>
        <View
          class="size-6 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
          accessibilityLabel={revealed() ? `Hide ${label} accounts` : `Reveal ${label} accounts`}
          onPress={() => revealed.update((on) => !on)}
        >
          <SettingsIcon name={revealed() ? "eye-off" : "eye"} size={14} />
        </View>
      </View>
      <Each of={groups()} key={(group) => group.host}>
        {(group) => {
          const choice = () => hosts()[group().host];
          const enabled = () => choice()?.enabled ?? true;
          const stalePin = () => choice()?.account !== undefined && !group().selectable.includes(choice()!.account!);
          const pinned = () => (choice()?.account !== undefined && !stalePin() ? choice()!.account! : ACTIVE_ACCOUNT);
          return (
            <View class="gap-2">
              <View class="flex-row items-center justify-between gap-3">
                <View class="min-w-0 gap-0.5">
                  <Text class="text-xs font-medium text-foreground">{group().host}</Text>
                  {group().selectable.length === 1 ? (
                    <View class="flex-row items-center gap-1">
                      <Text class="text-xs text-muted-foreground">Signed in as</Text>
                      <Login account={group().selectable[0]!} revealed={() => revealed()} />
                    </View>
                  ) : null}
                </View>
                <SettingsSwitch label={`Use ${label} on ${group().host}`} checked={enabled()} onChange={(next) => void save(group().host, { enabled: next })} />
              </View>
              {group().selectable.length > 1 ? (
                <View class="flex-row items-center justify-between gap-3">
                  <Text class="text-xs text-muted-foreground">Account</Text>
                  <SettingsSelect
                    label={`${label} account for ${group().host}`}
                    value={pinned()}
                    compactWidth={256}
                    options={[
                      { value: ACTIVE_ACCOUNT, label: `Active ${credentials.cliName} account${group().activeAccount && revealed() ? ` (${group().activeAccount})` : ""}` },
                      ...group().selectable.map((account, index) => ({ value: account, label: revealed() ? account : `Account ${index + 1}` })),
                    ]}
                    onChange={(next) => void save(group().host, { account: next === ACTIVE_ACCOUNT ? null : next })}
                  />
                </View>
              ) : null}
              {stalePin() ? (
                <View class="flex-row items-center justify-between gap-3">
                  <Text class="min-w-0 flex-1 text-xs text-warning-foreground">{`The chosen login is no longer signed in, so the active ${credentials.cliName} login is used.`}</Text>
                  <SettingsButton label="Use active login" disabled={saving()} onPress={() => void save(group().host, { account: null })} />
                </View>
              ) : null}
              <Each of={group().broken} key={(entry) => entry.account}>
                {(entry) => (
                  <View class="flex-row flex-wrap items-center gap-1">
                    <Login account={entry().account} revealed={() => revealed()} />
                    <Text class="text-xs text-muted-foreground">{`can't be used: ${entry().error ?? `${credentials.cliName} reports this login as invalid.`}`}</Text>
                  </View>
                )}
              </Each>
              {group().environmentVariable ? (
                <Text class="text-xs text-warning-foreground">{`${group().environmentVariable} is set on the server, so it overrides the account chosen here until it is unset.`}</Text>
              ) : null}
            </View>
          );
        }}
      </Each>
      {error() ? <Text class="text-xs text-destructive-foreground">{error()}</Text> : null}
    </View>
  );
}
