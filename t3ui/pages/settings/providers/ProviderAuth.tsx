// ProviderAuthenticationSection.tsx, ProviderAuthTerminal.tsx and the runtime half of
// ProviderSetupSection.tsx, driven by the real provider.auth.* / provider.install.* RPCs.
import { ConfirmDialog } from "./ConfirmDialog";
import { effect, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { SettingsSelect } from "../../../components/SettingsLayout";
import { isSafeProviderAuthUrl } from "../../../backend/providerSetup";
import type { ProviderAuthResponse, ProviderAuthState, ProviderInstallState } from "../../../store";
import type { ProviderApi } from "./data";
import { megabytes, type ProviderView } from "./logic";
import { ProviderAuthTerminal } from "./ProviderAuthTerminal";
import { ButtonText, ErrorText, IconButton, PillButton, Row } from "./ui";

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export function ProviderAuthentication(props: { divider?: boolean; api: ProviderApi; instanceId: string; provider: ProviderView; environmentLabel: string; readOnly: boolean }) {
  const auth = signal<ProviderAuthState | null>(null);
  const subscriptionError = signal<string | null>(null);
  const error = signal<string | null>(null);
  const pending = signal(false);
  const methodId = signal("");
  const draft = signal<{ id: string; values: Record<string, string> }>({ id: "", values: {} });
  const confirmingLogout = signal(false);
  let queue: Extract<ProviderAuthResponse, { type: "terminal" }>[] = [];
  let sending = false;

  effect(() => {
    const id = props.instanceId;
    auth.set(null); subscriptionError.set(null);
    return props.api.setup.subscribeAuth(id, (state) => { auth.set(state); subscriptionError.set(null); }, (cause) => subscriptionError.set(cause.message));
  });

  const interaction = () => auth()?.interaction ?? null;
  const active = () => ["starting", "waiting", "verifying"].includes(auth()?.phase ?? "");
  const signedIn = () => props.provider.auth.status === "authenticated" || (props.provider.auth.status === "unknown" && auth()?.phase === "succeeded");
  const isAcp = () => props.provider.driver === "acpRegistry";
  const discovering = () => isAcp() && !active() && !signedIn() && !subscriptionError() && auth() === null;
  const needsExternalSetup = () => !active() && !signedIn() && (props.provider.setup.canAuthenticate === false || (isAcp() && (auth()?.methods.length ?? 0) === 0 && auth() !== null));
  const usesCredentials = () => props.provider.driver === "antigravity" && (props.provider.auth.type === "gemini-api-key" || props.provider.auth.type === "agent-platform");
  const description = () => {
    const state = auth();
    if (active()) {
      if (state?.phase === "starting") return state.message ?? (usesCredentials() ? "Connecting…" : "Starting sign-in…");
      if (state?.phase === "verifying") return usesCredentials() ? "Checking credentials and loading models…" : "Checking your account…";
      if (interaction()?.type === "terminal") return "Complete sign-in in the terminal below.";
      if (interaction()?.type === "credentials") return "Enter your credentials below.";
      return "Finish signing in in your browser.";
    }
    if (signedIn()) return props.provider.auth.email ? `Signed in as ${props.provider.auth.email}` : "Signed in.";
    if (discovering()) return "Discovering sign-in methods…";
    if (needsExternalSetup()) return "No in-app sign-in advertised. Follow the provider's docs to finish setup.";
    return usesCredentials() ? `Connect on ${props.environmentLabel} to load models.` : `Sign in on ${props.environmentLabel}.`;
  };
  const disabled = () => props.readOnly || pending() || subscriptionError() !== null || discovering();
  const interactionId = () => { const item = interaction(); return item && item.type !== "unsupported" ? item.id : null; };
  const draftId = () => `${auth()?.flowId ?? ""}:${interactionId() ?? ""}`;
  const values = () => draft().id === draftId() ? draft().values : {};
  const url = () => {
    const item = interaction();
    const found = item && (item.type === "browser" || item.type === "deviceCode") ? item.url : auth()?.authorizationUrl ?? null;
    return found && isSafeProviderAuthUrl(found) ? found : null;
  };
  const showCallback = () => url() !== null && (interaction()?.type === "browser" ? (interaction() as { acceptsCallback?: boolean }).acceptsCallback === true : !interaction());
  const methods = () => auth()?.methods ?? [];

  async function run(command: () => Promise<unknown>): Promise<boolean> {
    if (pending()) return false;
    pending.set(true); error.set(null);
    try { await command(); return true; }
    catch (cause) { error.set(message(cause, "Provider sign-in failed. Try again.")); return false; }
    finally { pending.set(false); }
  }
  async function send(response: ProviderAuthResponse): Promise<boolean> {
    const state = auth(); const item = interaction();
    if (!state?.flowId || !item || item.type === "unsupported") return false;
    return run(async () => { auth.set(await props.api.setup.respondAuth(props.instanceId, state.flowId as string, item.id, response)); });
  }
  async function openBrowser() {
    const target = url();
    if (!target || props.readOnly) return;
    const item = interaction();
    if (item?.type === "browser" && item.requiresConsent && !(await send({ type: "browser", action: "accept" }))) return;
    error.set(null);
    if (!props.api.openExternalChecked) { props.api.openExternal(target); return; }
    if (!(await props.api.openExternalChecked(target))) error.set("Could not open the sign-in page. Copy the link and open it in your browser.");
  }
  function copyLink() {
    const target = url();
    if (!target) return;
    props.api.copy(target);
    const item = interaction();
    if (item?.type === "browser" && item.requiresConsent) void send({ type: "browser", action: "accept" }).then((sent) => { if (!sent) error.set("Could not copy the sign-in link."); });
  }
  function terminalResponse(response: Extract<ProviderAuthResponse, { type: "terminal" }>) {
    const state = auth(); const item = interaction();
    if (props.readOnly || !state?.flowId || !item || item.type === "unsupported") return;
    for (let offset = 0; offset < Math.max(1, response.data.length); offset += 4096) queue.push({ ...response, data: response.data.slice(offset, offset + 4096) });
    if (sending) return;
    sending = true;
    void (async () => {
      try {
        while (queue.length > 0) {
          const next = queue.shift() as Extract<ProviderAuthResponse, { type: "terminal" }>;
          auth.set(await props.api.setup.respondAuth(props.instanceId, state.flowId as string, item.id, next));
        }
      } catch { queue = []; error.set("The provider sign-in terminal is no longer available."); }
      finally { sending = false; }
    })();
  }
  const mainLabel = () => signedIn() ? "Change account"
    : auth()?.phase === "failed" || auth()?.phase === "cancelled" ? (usesCredentials() ? "Retry connection" : "Retry sign-in")
    : usesCredentials() ? "Connect" : "Sign in";
  const canLogout = () => !active() && signedIn() && (props.provider.auth.canLogout ?? props.provider.setup.canAuthenticate) === true;

  return <Row testID="Provider account" title="Account" divider={props.divider === true}
    description={<Text class="text-xs leading-normal text-muted-foreground">{description()}</Text>}
    status={auth()?.phase === "failed" && auth()?.message ? <Text class="text-xs text-muted-foreground">{auth()?.message}</Text> : null}
    control={<View class="flex-row flex-wrap items-center justify-end gap-1.5">
      {!active() && methods().length > 1 ? <SettingsSelect label="Sign-in method" value={methods().some((method) => method.id === methodId()) ? methodId() : ""}
        options={[{ value: "", label: "Provider default" }, ...methods().map((method) => ({ value: method.id, label: method.name }))]} onChange={(next) => methodId.set(next)} /> : null}
      {url() ? <>
        <PillButton label="Open browser" disabled={disabled()} onPress={() => void openBrowser()}><ButtonText>Open browser</ButtonText></PillButton>
        <IconButton label="Copy sign-in link" icon="copy" disabled={disabled()} onPress={copyLink} />
      </> : null}
      {needsExternalSetup() && props.provider.setup.documentationUrl
        ? <PillButton label="Open docs" onPress={() => props.api.openExternal(props.provider.setup.documentationUrl as string)}><ButtonText>Open docs</ButtonText></PillButton>
        : active() && auth()?.flowId
          ? <PillButton label="Cancel sign-in" variant="ghost" disabled={disabled()} onPress={() => void run(async () => { auth.set(await props.api.setup.cancelAuth(props.instanceId, auth()?.flowId as string)); })}><ButtonText tone="muted">Cancel</ButtonText></PillButton>
          : !active() && !needsExternalSetup() && props.provider.setup.canAuthenticate !== false
            ? <PillButton label={mainLabel()} disabled={disabled() || !props.provider.enabled || !props.provider.installed || auth() === null}
              onPress={() => void run(async () => {
                const chosen = methods().some((method) => method.id === methodId()) ? methodId() : "";
                auth.set(await props.api.setup.startAuth(props.instanceId, chosen ? { methodId: chosen } : {}));
              })}><ButtonText>{mainLabel()}</ButtonText></PillButton> : null}
      {canLogout() ? <PillButton label="Sign out" variant="ghost" disabled={disabled() || auth() === null} onPress={() => confirmingLogout.set(true)}><ButtonText>Sign out</ButtonText></PillButton> : null}
    </View>}>
    {confirmingLogout() ? <View testID="Confirm sign out" class="gap-2 rounded-lg border border-border-60 p-3">
      <Text class="text-sm text-foreground">{`Sign out of ${props.provider.displayName ?? props.provider.driver} on ${props.environmentLabel}? This stops running threads that share this sign-in. Thread history is kept.`}</Text>
      <View class="flex-row gap-2">
        <PillButton label="Confirm sign out" size="xs" onPress={() => { confirmingLogout.set(false); void run(async () => { auth.set(await props.api.setup.logout(props.instanceId)); }); }}><ButtonText>Sign out</ButtonText></PillButton>
        <PillButton label="Keep signed in" size="xs" variant="ghost" onPress={() => confirmingLogout.set(false)}><ButtonText tone="muted">Cancel</ButtonText></PillButton>
      </View>
    </View> : null}
    {interaction()?.type === "deviceCode" ? <Text class="py-2 text-sm text-muted-foreground">{`Enter code ${(interaction() as { userCode: string }).userCode} in your browser.`}</Text> : null}
    {interaction()?.type === "unsupported" ? <Text class="py-2 text-sm text-muted-foreground">This sign-in step is not supported in this client. Cancel and use another method.</Text> : null}
    {interaction()?.type === "terminal" ? <ProviderAuthTerminal output={(interaction() as { output: string }).output} outputOffset={(interaction() as { outputOffset?: number }).outputOffset} onResponse={terminalResponse} /> : null}
    {interaction()?.type === "credentials" ? <View class="gap-2 py-2">
      <Each of={(interaction() as { fields: { name: string; label: string; secret: boolean }[] }).fields} key={(field) => field.name}>{(field) => <View class="gap-1">
        <Text class="text-sm text-foreground">{field().label}</Text>
        <Input accessibilityLabel={field().label} masked={field().secret} readonly={disabled()} maxLength={16384} value={values()[field().name] ?? ""} autoCapitalize="none" autoCorrect={false}
          onChange={(event) => draft.set({ id: draftId(), values: { ...values(), [field().name]: event.value } })}
          class="h-8 rounded-md border border-input bg-background px-2.5 text-sm text-foreground" />
      </View>}</Each>
      <PillButton label="Connect credentials" disabled={disabled()} onPress={() => void send({ type: "credentials", values: values() }).then((sent) => { if (sent) draft.set({ id: "", values: {} }); })}><ButtonText>Connect</ButtonText></PillButton>
    </View> : null}
    {showCallback() ? <View class="gap-2 py-2">
      <Text class="text-sm text-muted-foreground">If the final localhost page does not load, paste its full URL here.</Text>
      <Input accessibilityLabel="Sign-in callback URL" readonly={disabled()} maxLength={16384} value={values().callback ?? ""} autoCapitalize="none" autoCorrect={false}
        onChange={(event) => draft.set({ id: draftId(), values: { ...values(), callback: event.value } })}
        class="h-8 rounded-md border border-input bg-background px-2.5 text-sm text-foreground" />
      <PillButton label="Continue sign-in" disabled={disabled() || !values().callback?.trim()}
        onPress={() => void run(async () => { auth.set(await props.api.setup.completeAuth(props.instanceId, auth()?.flowId as string, values().callback as string)); }).then((sent) => { if (sent) draft.set({ id: "", values: {} }); })}><ButtonText>Continue</ButtonText></PillButton>
    </View> : null}
    {error() || subscriptionError() ? <ErrorText>{error() ?? subscriptionError()}</ErrorText> : null}
  </Row>;
}

/** The Runtime row of ProviderSetupSection: download, install, cancel and remove a managed runtime. */
export function ProviderRuntime(props: { divider?: boolean; api: ProviderApi; instanceId: string; provider: ProviderView; label: string; environmentLabel?: string; binaryPath: string; enabled: boolean; readOnly: boolean }) {
  const install = signal<ProviderInstallState | null>(null);
  const subscriptionError = signal<string | null>(null);
  const error = signal<string | null>(null);
  const pendingLabel = signal<string | null>(null);
  const confirmingRemoval = signal(false);
  // "Retry setup status": a failed status subscription is opened again.
  const statusRetry = signal(0);

  effect(() => {
    const id = props.instanceId;
    statusRetry();
    install.set(null); subscriptionError.set(null);
    return props.api.setup.subscribeInstall(id, (state) => { install.set(state); subscriptionError.set(null); }, (cause) => subscriptionError.set(cause.message));
  });
  const active = () => ["downloading", "extracting", "verifying"].includes(install()?.phase ?? "");
  const usesCustomBinary = () => props.binaryPath.trim().length > 0;
  const installed = () => props.provider.installed || (!usesCustomBinary() && install()?.installedVersion != null);
  const disabled = () => props.readOnly || pendingLabel() !== null || subscriptionError() !== null;
  const status = () => {
    const state = install();
    if (state === null) return `Checking the ${props.label} runtime.`;
    if (state.phase === "downloading") return `Downloading ${megabytes(state.downloadedBytes)} MB${state.totalBytes === null ? "" : ` of ${megabytes(state.totalBytes)} MB`}.`;
    if (state.phase === "extracting") return `Extracting ${props.label}.`;
    if (state.phase === "verifying") return "Checking the downloaded runtime.";
    if (installed()) return "Installed.";
    if (usesCustomBinary()) return props.enabled ? `The configured ${props.label} runtime is unavailable.` : `The configured ${props.label} runtime has not been checked.`;
    return state.totalBytes ? `${Math.ceil(state.totalBytes / 1_000_000)} MB download.` : "Not installed.";
  };
  const percent = () => { const state = install(); return state && state.phase === "downloading" && state.totalBytes ? Math.min(100, (state.downloadedBytes / state.totalBytes) * 100) : null; };
  const installLabel = () => {
    const state = install();
    if (state?.installedVersion) return state.version && state.version !== state.installedVersion ? `Update ${props.label}` : `Reinstall ${props.label}`;
    if (state?.phase === "failed" || state?.phase === "cancelled") return "Retry installation";
    return installed() ? "Install managed runtime" : `Install ${props.label}`;
  };
  async function run(label: string, command: () => Promise<ProviderInstallState>) {
    if (pendingLabel() !== null) return;
    pendingLabel.set(label); error.set(null);
    try { install.set(await command()); }
    catch (cause) { error.set(message(cause, "Provider setup failed. Try again.")); }
    finally { pendingLabel.set(null); }
  }
  return <Row testID="Provider runtime" divider={props.divider === true} title="Runtime" description={`Install and manage ${props.label}.`}
    status={<View class="gap-1">
      {usesCustomBinary() ? <Text class="text-xs text-muted-foreground">Uses the custom binary path below. Installation keeps that path.</Text> : null}
      {!installed() && props.provider.setup.canInstall !== true ? <Text class="text-xs text-muted-foreground">Automatic installation unavailable. Set a binary path or use another environment.</Text> : null}
    </View>}
    control={<View class="w-56 gap-2">
      <Text class="text-right text-xs text-muted-foreground">{status()}</Text>
      {percent() !== null ? <View accessibilityLabel={`${props.label} download`} class="h-1 overflow-hidden rounded-full bg-muted"><View class="h-1 rounded-full bg-primary" style={{ width: `${percent() ?? 0}%` }} /></View> : null}
      {!active() && install()?.message && install()?.message !== status() ? <Text class="text-right text-xs text-muted-foreground">{install()?.message}</Text> : null}
      <View class="flex-row items-center justify-end gap-2">
        {install()?.canRemove && !active() ? <IconButton label="Remove downloaded runtime" icon="trash-2" disabled={disabled()} onPress={() => confirmingRemoval.set(true)} /> : null}
        {active() && install()?.operationId
          ? <PillButton label="Cancel installation" disabled={disabled()} onPress={() => void run("Cancelling installation", () => props.api.setup.cancelInstall(props.instanceId, install()?.operationId as string))}><ButtonText>Cancel installation</ButtonText></PillButton>
          : !active() && props.provider.setup.canInstall === true
            ? <PillButton label={installLabel()} disabled={disabled()} onPress={() => void run("Starting installation", () => props.api.setup.startInstall(props.instanceId))}><ButtonText>{installLabel()}</ButtonText></PillButton> : null}
      </View>
    </View>}>
    {confirmingRemoval() ? <ConfirmDialog testID="Confirm runtime removal" message={`Remove the downloaded ${props.label} runtime from ${props.environmentLabel ?? "this environment"}? Google sign-in and thread history are kept.`} confirmLabel="Remove" cancelLabel="Keep runtime" confirmAccessibilityLabel="Confirm remove runtime"
      onClose={() => confirmingRemoval.set(false)} onConfirm={() => { confirmingRemoval.set(false); void run("Removing runtime", () => props.api.setup.removeInstall(props.instanceId)); }} /> : null}
    {error() || subscriptionError() ? <ErrorText>{error() ?? subscriptionError()}</ErrorText> : null}
    {subscriptionError() ? <PillButton label="Retry setup status" onPress={() => statusRetry.update((value) => value + 1)}><ButtonText>Retry setup status</ButtonText></PillButton> : null}
  </Row>;
}

