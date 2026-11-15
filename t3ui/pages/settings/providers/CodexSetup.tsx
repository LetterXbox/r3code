// CodexSetupSection.tsx (managed mode), CodexManagedRuntimeFields and AddCodexAccountDialog.tsx: Codex run by
// T3 Code itself and signed in with a ChatGPT account.
import { effect, signal, Text, token, View } from "nsh";
import { Icon } from "../../../components/Icons";
import { Dialog } from "nsh/base";
import type { ProviderAuthMethod, ProviderAuthState, ProviderInstallState } from "../../../store";
import { RedactedSensitiveText } from "./RedactedText";
import type { ProviderApi } from "./data";
import { readCodexSetupMode, settleAuthorizationPage, settleProviderInstall } from "./codexSetupLogic";
import { megabytes, providerSummary, type ProviderView } from "./logic";
import { ButtonText, DraftInput, ErrorText, PillButton, ProviderIconView, Row, UiIcon } from "./ui";
import { useOverlayOpen } from "../../../components/rightPanel/nativeOcclusion";
import { dialogBackdropStyle, dialogPopupMotion, keepPressInDialog } from "../../../components/dialogSurface";
import { DialogCloseButton } from "../../../components/DialogCloseButton";

export { readCodexSetupMode };

const MULTIPLE_ACCOUNTS_FAQ_URL = "https://github.com/pingdotgg/t3code/blob/main/docs/user/faq.md#can-i-add-a-bunch-of-accounts-for-one-provider";

function message(cause: unknown, fallback: string): string { return cause instanceof Error && cause.message ? cause.message : fallback; }

/** ChatGptConnectionButton: the OpenAI mark and "Continue with ChatGPT". */
function ChatGptButton(props: { label?: string; disabled?: boolean; variant?: "outline" | "primary" | "ghost"; onPress: () => void }) {
  const text = () => props.label ?? "Continue with ChatGPT";
  return <PillButton label={text()} variant={props.variant} disabled={props.disabled} onPress={props.onPress}>
    <ProviderIconView driver="codex" name="OpenAI" size={20} /><ButtonText>{text()}</ButtonText></PillButton>;
}

/** MultipleAccountsNote: shown while adding an account when one is already signed in. */
export function MultipleAccountsNote(props: { api: ProviderApi; driver: "codex" | "claudeAgent" }) {
  const name = props.driver === "codex" ? "Codex" : "Claude";
  const show = () => props.api.providers().some((provider) => provider.driver === props.driver && provider.auth.status === "authenticated");
  // MultipleAccountsNote: Alert variant="info" (rounded-xl border-info/32 bg-info/4 px-3.5 py-3, InfoIcon size-4 in
  // text-info, gap-2) whose description runs the "More info" link on inline after the sentence.
  return show() ? <View testID="Multiple accounts note" class="flex-row items-start gap-2 rounded-xl border border-info-32 bg-info-4 px-3.5 py-3">
    <View class="h-5 justify-center"><Icon name="info" size={16} tint={token("info")} /></View>
    <Text class="min-w-0 flex-1 text-sm text-muted-foreground">{`We do not recommend managing multiple ${name} accounts in R3 Code. `}<Text accessibilityLabel="More info about multiple accounts" role="link" onPress={() => props.api.openExternal(MULTIPLE_ACCOUNTS_FAQ_URL)} class="text-sm text-muted-foreground underline">More info</Text></Text>
  </View> : null;
}

const CHATGPT_USAGE_URL = "https://chatgpt.com/#settings/Usage";

/** ChatGptAccountPicker: which saved ChatGPT account to reconnect, or a different one. */
export function ChatGptAccountPicker(props: {
  methods: readonly ProviderAuthMethod[]; onClose: () => void; onSelect: (methodId: string) => void; onRemove: (methodId: string) => void;
  disabled: boolean; canRemove: boolean; error: string | null;
}) {
  useOverlayOpen(true, "chatgpt account picker");
  const profiles = () => props.methods.filter((method) => method.id.startsWith("chatgpt-profile:"));
  const selection = signal<string | null>(null);
  const selectedId = () => selection() === "chatgpt-change-account" ? "chatgpt-change-account" : profiles().find((profile) => profile.id === selection())?.id ?? profiles()[0]?.id ?? "chatgpt-change-account";
  const choice = (id: string, label: string, mono: boolean) => <View accessibilityLabel={label} role="radio" accessibilityState={{ checked: selectedId() === id, disabled: props.disabled }} testID={`ChatGPT account ${id}`}
    onPress={() => { if (!props.disabled) selection.set(id); }} class="flex-row items-center gap-3 rounded-lg border border-border px-3 py-3">
    <View class={`size-4 items-center justify-center rounded-full border ${selectedId() === id ? "border-primary bg-primary" : "border-input bg-background"}`}>{selectedId() === id ? <View class="size-1.5 rounded-full bg-primary-foreground" /> : null}</View>
    <Text class={`min-w-0 flex-1 text-sm font-medium text-foreground ${mono ? "" : ""}`}>{label}</Text>
  </View>;
  const removable = () => profiles().find((profile) => profile.id === selectedId())?.canRemove === true;
  return <Dialog open animation="fade" onCancel={props.onClose} onOpenChange={({ open }) => { if (!open) props.onClose(); }} testID="ChatGPT account picker" backdropStyle={dialogBackdropStyle()} style={[{ margin: "auto", width: 512, maxWidth: "92%" }, dialogPopupMotion()]}>
    <View class="relative w-full flex-col overflow-hidden rounded-2xl border border-border bg-background" onPress={keepPressInDialog}>
      <DialogCloseButton onClose={props.onClose} />
      <View class="gap-1 px-6 pt-6 pb-4">
        <Text class="text-lg font-semibold text-foreground">Reconnect ChatGPT</Text>
        <Text class="text-sm text-muted-foreground">On OpenAI, sign in with the account you choose here.</Text>
      </View>
      <View accessibilityLabel="ChatGPT account to connect" role="radiogroup" class="gap-2 px-6 pb-6">
        <Each of={profiles()} key={(profile) => profile.id}>{(profile) => choice(profile().id, profile().name, true)}</Each>
        {choice("chatgpt-change-account", "Use a different account", false)}
      </View>
      {props.error ? <View class="px-6 pb-3"><Text role="alert" class="text-sm text-destructive-foreground">{props.error}</Text></View> : null}
      <View class="flex-row items-center justify-end gap-2 px-6 pb-6">
        {removable() ? <PillButton label="Remove connection" variant="ghost" disabled={props.disabled || !props.canRemove} onPress={() => props.onRemove(selectedId())}><ButtonText>Remove connection</ButtonText></PillButton> : null}
        <ChatGptButton disabled={props.disabled} onPress={() => props.onSelect(selectedId())} />
      </View>
    </View>
  </Dialog>;
}

/** ChatGptUsageButton: opens ChatGPT's usage settings. */
function ChatGptUsageButton(props: { api: ProviderApi }) {
  return <View accessibilityLabel="Manage usage" role="button" onPress={() => props.api.openExternal(CHATGPT_USAGE_URL)} class="h-8 flex-row items-center gap-1.5 rounded-md px-3 hover:bg-accent-50">
    <Text class="text-sm text-muted-foreground">Manage usage</Text><UiIcon name="external-link" size={14} />
  </View>;
}

export function CodexManagedSetup(props: {
  api: ProviderApi; instanceId: string; provider: ProviderView | undefined; enabled: boolean; readOnly: boolean; divider?: boolean;
  autoStart?: boolean; allowExistingCli?: boolean; onModeChange: (mode: "managed" | "existing") => void; onSignInCancelled?: () => void;
  /** "onboarding" draws the Welcome page's CodexWelcomeCard instead of the settings row. */
  presentation?: "settings" | "onboarding"; displayName?: string; existingCliDisabled?: boolean;
}) {
  const auth = signal<ProviderAuthState | null>(null);
  const install = signal<ProviderInstallState | null>(null);
  const pending = signal(false);
  const error = signal<string | null>(null);
  const statusFailed = signal(false);
  const flowId = signal<string | null>(null);
  const opened = signal<string | null>(null);
  const started = signal<ProviderInstallState | null>(null);
  const awaiting = signal(false);
  const pickerOpen = signal(false);
  const requestedMethod = signal("chatgpt");
  const helpOpen = signal(false);
  const callback = signal({ flowId: "", value: "" });
  const autoStartHandled = signal(false);
  let autoStarted = false;

  effect(() => {
    const id = props.instanceId;
    auth.set(null); install.set(null); statusFailed.set(false);
    const stopAuth = props.api.setup.subscribeAuth(id, (state) => auth.set(state), () => statusFailed.set(true));
    const stopInstall = props.api.setup.subscribeInstall(id, (state) => install.set(state), () => statusFailed.set(true));
    return () => { stopAuth(); stopInstall(); };
  });

  const installActive = () => ["downloading", "extracting", "verifying"].includes(install()?.phase ?? "");
  const authenticated = () => props.provider?.auth.status === "authenticated";
  const installed = () => props.provider?.installed === true || install()?.installedVersion != null;
  const finishing = () => awaiting() && !authenticated() && auth()?.phase === "succeeded";
  const startingAutomatically = () => props.autoStart === true && !autoStartHandled();
  const waitingForAuthState = () => awaiting() && !authenticated() && (auth() === null || auth()?.phase === "idle");
  const authInProgress = () => finishing() || waitingForAuthState() || ["starting", "waiting", "verifying"].includes(auth()?.phase ?? "");
  const authActive = () => startingAutomatically() || authInProgress() || (pending() && !installActive());
  const unavailable = () => props.readOnly || !props.enabled || pending() || props.provider === undefined || statusFailed();
  const busy = () => pending() || authInProgress() || installActive();
  const hasSavedAccount = () => (auth()?.methods ?? []).some((method) => method.id.startsWith("chatgpt-profile:"));
  const pageUrl = () => { const state = auth(); const interaction = state?.interaction; return interaction?.type === "browser" ? interaction.url : state?.authorizationUrl ?? null; };
  const logoutWarning = () => auth()?.phase === "idle" && auth()?.message?.startsWith("Signed out locally.") ? auth()?.message ?? null : null;

  // The flow ended (signed in, failed or cancelled) elsewhere: stop waiting for it.
  effect(() => { if (awaiting() && (authenticated() || auth()?.phase === "failed" || auth()?.phase === "cancelled")) awaiting.set(false); });
  // The server does not refresh the provider snapshot when a sign-in flow succeeds, and the flow can finish elsewhere
  // (callback, pasted redirect URL).
  effect(() => { if (awaiting() && auth()?.phase === "succeeded") void props.api.refreshInstance(props.instanceId).catch(() => {}); });

  async function run<T>(command: () => Promise<T>): Promise<T | null> {
    if (pending()) return null;
    pending.set(true); error.set(null);
    try { return await command(); }
    catch (cause) { error.set(message(cause, "Codex setup failed. Try again.")); return null; }
    finally { pending.set(false); }
  }
  async function signIn(methodId: string) {
    requestedMethod.set(methodId);
    const state = await run(() => props.api.setup.startAuth(props.instanceId, { methodId, callbackMode: "server" }));
    if (state) { awaiting.set(true); auth.set(state); flowId.set(state.flowId); }
  }
  async function setup(methodId = "chatgpt") {
    if (unavailable() || busy()) return;
    if (installed()) { await signIn(methodId); return; }
    const result = await run(() => props.api.setup.startInstall(props.instanceId));
    if (result) { install.set(result); started.set(result); }
  }
  // A managed install this client started continues into sign-in once it lands.
  effect(() => {
    const begun = started();
    if (begun === null) return;
    const settled = settleProviderInstall(begun, install());
    if (settled === undefined) return;
    started.set(null);
    if (settled) void signIn(requestedMethod()); else error.set(install()?.message ?? "Codex could not be installed.");
  });
  // The sign-in page opens once for the flow this client started.
  effect(() => {
    const url = settleAuthorizationPage(auth(), flowId());
    if (typeof url !== "string" || opened() === url || flowId() === null) return;
    opened.set(url);
    // openPage: a page that will not open asks for the pasted redirect URL instead (CodexSetupSection.tsx:487).
    if (!props.api.openExternalChecked) { props.api.openExternal(url); return; }
    void props.api.openExternalChecked(url).then((ok) => { if (!ok) error.set("Could not finish sign-in on this computer. Try again or paste the redirect URL below."); });
  });
  effect(() => {
    if (!startingAutomatically() || unavailable() || busy() || install() === null || !props.provider?.setup.canInstall) return;
    if (autoStarted) return;
    autoStarted = true; autoStartHandled.set(true);
    void setup();
  });

  const runtimeDescription = () => {
    const state = install();
    if (state?.phase === "downloading") return `Downloading ${megabytes(state.downloadedBytes)}${state.totalBytes === null ? "" : ` of ${megabytes(state.totalBytes)}`} MB.`;
    if (state?.phase === "extracting") return "Installing Codex.";
    if (state?.phase === "verifying") return "Checking Codex.";
    if (installed()) return `${state?.source === "local" ? "Using your installed Codex" : "Managed by R3 Code"}${state?.installedVersion ? ` · v${state.installedVersion}` : ""}.`;
    return state?.message ?? "R3 Code downloads and manages Codex for you.";
  };
  const reconnectEmail = () => (auth()?.methods ?? []).find((method) => method.id === "chatgpt")?.accountEmail;
  const requestedEmail = () => (auth()?.methods ?? []).find((method) => method.id === requestedMethod())?.accountEmail;
  const description = (): any => {
    if (finishing()) return "Finishing sign-in...";
    if (installActive()) return runtimeDescription();
    if (authActive() || auth()?.phase === "failed" || auth()?.phase === "cancelled") return auth()?.phase === "waiting" && requestedEmail() ? `Continue as ${requestedEmail()} on OpenAI.` : auth()?.message ?? "Finish signing in in your browser.";
    if (authenticated()) return props.provider?.auth.email?.trim()
      ? <View class="flex-row flex-wrap items-center"><Text class="text-xs text-muted-foreground">Signed in as </Text><RedactedSensitiveText value={props.provider.auth.email} ariaLabel="Toggle account email visibility" revealTooltip="Click to reveal email" hideTooltip="Click to hide email" /><Text class="text-xs text-muted-foreground">.</Text></View>
      : "Signed in with ChatGPT.";
    return reconnectEmail() ?? "Use your ChatGPT subscription.";
  };
  const cancelSignIn = async () => {
    awaiting.set(false);
    const id = auth()?.flowId;
    if (!id) return;
    const state = await run(() => props.api.setup.cancelAuth(props.instanceId, id));
    if (state) auth.set(state);
  };
  const submitCallback = async () => {
    const state = auth(); const value = callback().value.trim();
    if (!state?.flowId || !value) return;
    const submitted = state.flowId;
    const next = await run(() => props.api.setup.completeAuth(props.instanceId, submitted, value));
    if (next) { auth.set(next); callback.set({ flowId: submitted, value: "" }); }
  };
  const callbackValue = () => callback().flowId === auth()?.flowId ? callback().value : "";
  const connectDisabled = () => unavailable() || busy() || (!installed() ? props.provider?.setup?.canInstall !== true : props.provider?.setup?.canAuthenticate !== true);
  const showFallback = () => auth()?.phase === "waiting" && pageUrl() !== null;
  const settingsError = () => error() ?? (statusFailed() ? "Could not read Codex setup status. Reconnect and try again." : install()?.phase === "failed" ? install()?.message ?? null : null);
  const waitingLabel = () => finishing() ? "Finishing sign-in..." : auth()?.phase === "waiting" ? "Open sign-in page" : "Signing in...";
  const rule = () => <View class="h-px bg-border-50" />;

  // CodexSetupSection: a provider that cannot authenticate yet (its setup is still being prepared) shows only this row.
  const preparing = () => !props.provider?.setup?.canAuthenticate;
  const fallbackContent = () => <View class="w-full gap-3 border-t border-border-50 pt-3">
    <Text class="text-xs leading-relaxed text-muted-foreground">If sign-in doesn't return to R3 Code, paste the URL from the final localhost page.</Text>
    <View class="flex-row items-center gap-2">
      <DraftInput label="ChatGPT sign-in redirect URL" masked disabled={pending() || props.readOnly} value={callbackValue()} placeholder="Paste the URL from the sign-in tab" class="min-w-0 flex-1"
        onCommit={(value) => callback.set({ flowId: auth()?.flowId ?? "", value })} />
      <PillButton label="Connect" disabled={pending() || props.readOnly || !callbackValue().trim()} onPress={() => void submitCallback()}><ButtonText>Connect</ButtonText></PillButton>
    </View>
    <View accessibilityLabel="Try sign-in in your browser" role="button" onPress={() => props.api.openExternal(pageUrl() as string)} class="h-7 flex-row items-center gap-1.5 self-start rounded-md px-2 hover:bg-accent-50">
      <Text class="text-xs text-muted-foreground">Try sign-in in your browser</Text><UiIcon name="external-link" size={14} />
    </View>
  </View>;
  if (props.presentation === "onboarding") {
    const title = () => props.displayName || props.provider?.displayName || "Codex";
    const onboardingDescription = (): any => {
      if (installActive()) return runtimeDescription();
      if (authenticated()) return props.provider?.auth.email?.trim()
        ? <View class="flex-row flex-wrap items-center"><Text class="text-xs text-muted-foreground">Signed in as </Text><RedactedSensitiveText value={props.provider.auth.email} ariaLabel="Toggle account email visibility" revealTooltip="Click to reveal email" hideTooltip="Click to hide email" /><Text class="text-xs text-muted-foreground">.</Text></View>
        : "Connected to ChatGPT.";
      if (showFallback()) return <CodexSignInDescription expanded={helpOpen()} onToggle={() => helpOpen.update((open) => !open)} />;
      if (startingAutomatically() || waitingForAuthState() || auth()?.phase === "starting" || auth()?.phase === "waiting" || (pending() && !installActive())) return <CodexSignInDescription />;
      if (authActive() || auth()?.phase === "failed" || auth()?.phase === "cancelled") return description();
      return "Code with your ChatGPT subscription.";
    };
    const onboardingWaitingLabel = () => finishing() ? "Finishing sign-in..." : "Open sign-in page";
    const onboardingError = () => logoutWarning() ?? error() ?? (statusFailed() ? "Could not read setup status. Reconnect and try again." : install()?.phase === "failed" ? install()?.message ?? null : null);
    return () => preparing()
      ? <CodexWelcomeCard title={title()} description={<CodexSignInDescription />}
          control={<PillButton label="Open sign-in page" disabled onPress={() => {}}><ButtonText>Open sign-in page</ButtonText></PillButton>}
          secondaryControl={<PillButton label="Cancel" variant="ghost" disabled onPress={() => {}}><ButtonText tone="muted">Cancel</ButtonText></PillButton>} />
      : <View>
        {pickerOpen() ? <ChatGptAccountPicker methods={auth()?.methods ?? []} onClose={() => pickerOpen.set(false)} disabled={unavailable() || busy()} canRemove={!props.readOnly} error={error()}
          onRemove={(methodId) => { void run(() => props.api.setup.removeAuthMethod(props.instanceId, methodId)).then((state) => { if (state) auth.set(state); }); }}
          onSelect={(methodId) => { pickerOpen.set(false); void setup((auth()?.methods ?? []).some((method) => method.id === methodId) ? methodId : "chatgpt-change-account"); }} /> : null}
        <CodexWelcomeCard title={title()} description={onboardingDescription()}
          control={authenticated() && !busy()
            ? <CodexReady />
            : authActive()
              ? <PillButton label={onboardingWaitingLabel()} disabled={!pageUrl() || auth()?.phase !== "waiting"} onPress={() => props.api.openExternal(pageUrl() as string)}><ButtonText>{onboardingWaitingLabel()}</ButtonText></PillButton>
              : <ChatGptButton label={installActive() || pending() ? "Setting up..." : hasSavedAccount() ? "Reconnect account" : "Continue with ChatGPT"} disabled={connectDisabled()} onPress={() => { if (hasSavedAccount()) pickerOpen.set(true); else void setup(); }} />}
          secondaryControl={(authActive() && !finishing()) || installActive()
            ? <PillButton label="Cancel" variant="ghost" disabled={pending() || props.readOnly} onPress={() => {
                if (auth()?.flowId && authActive()) { void cancelSignIn(); return; }
                const id = install()?.operationId;
                if (id) { started.set(null); void run(() => props.api.setup.cancelInstall(props.instanceId, id)).then((state) => { if (state) install.set(state); }); }
              }}><ButtonText tone="muted">Cancel</ButtonText></PillButton>
            : !authActive() && !authenticated() && hasSavedAccount()
              ? <PillButton label="Use a different account" variant="ghost" disabled={unavailable() || busy()} onPress={() => void setup("chatgpt-change-account")}><ButtonText tone="muted">Use a different account</ButtonText></PillButton>
              : !authActive() && !authenticated() && props.allowExistingCli !== false
                ? <PillButton label="Use existing CLI" variant="ghost" disabled={props.readOnly || busy() || props.existingCliDisabled === true} onPress={() => props.onModeChange("existing")}><ButtonText tone="muted">Use existing CLI</ButtonText></PillButton>
                : null}>
          {showFallback() && helpOpen() ? fallbackContent() : null}
          {onboardingError() ? <Text role="alert" class="text-xs text-destructive-foreground">{onboardingError()}</Text> : null}
        </CodexWelcomeCard>
      </View>;
  }
  return () => preparing() ? <View testID="Codex setup"><Row divider={props.divider === true} title="ChatGPT account" description="Preparing sign-in." /></View> : <View testID="Codex setup">
    {pickerOpen() ? <ChatGptAccountPicker methods={auth()?.methods ?? []} onClose={() => pickerOpen.set(false)} disabled={unavailable() || busy()} canRemove={!props.readOnly} error={error()}
      onRemove={(methodId) => { void run(() => props.api.setup.removeAuthMethod(props.instanceId, methodId)).then((state) => { if (state) auth.set(state); }); }}
      onSelect={(methodId) => { pickerOpen.set(false); void setup((auth()?.methods ?? []).some((method) => method.id === methodId) ? methodId : "chatgpt-change-account"); }} /> : null}
    <Row divider={props.divider === true} title="ChatGPT account" description={description()}
      control={<View class="max-w-88 flex-row flex-wrap items-center justify-end gap-2">
        {authActive() ? <>
          <PillButton label={waitingLabel()} disabled={!pageUrl() || auth()?.phase !== "waiting"} onPress={() => props.api.openExternal(pageUrl() as string)}><ButtonText>{waitingLabel()}</ButtonText></PillButton>
          {!finishing() ? <PillButton label="Cancel sign-in" variant="ghost" disabled={pending() || props.readOnly} onPress={() => { if (!auth()?.flowId) return; void cancelSignIn(); props.onSignInCancelled?.(); }}><ButtonText>Cancel</ButtonText></PillButton> : null}
        </> : installActive() ? <PillButton label="Cancel installation" variant="ghost" disabled={pending() || props.readOnly}
          onPress={() => { const id = install()?.operationId; if (id) { started.set(null); void run(() => props.api.setup.cancelInstall(props.instanceId, id)).then((state) => { if (state) install.set(state); }); } }}><ButtonText>Cancel</ButtonText></PillButton>
        : authenticated() ? <>
          <PillButton label="Change account" disabled={unavailable() || busy()} onPress={() => pickerOpen.set(true)}><ButtonText>Change account</ButtonText></PillButton>
          <PillButton label="Disconnect" variant="ghost" disabled={unavailable() || busy()} onPress={() => void run(() => props.api.setup.logout(props.instanceId)).then((state) => { if (state) auth.set(state); })}><ButtonText>Disconnect</ButtonText></PillButton>
        </> : <>
          <ChatGptButton label={pending() ? "Setting up..." : hasSavedAccount() ? "Reconnect account" : "Continue with ChatGPT"} disabled={connectDisabled()} onPress={() => { if (hasSavedAccount()) pickerOpen.set(true); else void setup(); }} />
          {hasSavedAccount() ? <PillButton label="Use a different account" variant="ghost" disabled={unavailable() || busy()} onPress={() => void setup("chatgpt-change-account")}><ButtonText>Use a different account</ButtonText></PillButton> : null}
          {props.allowExistingCli !== false ? <PillButton label="Use existing CLI" variant="ghost" disabled={props.readOnly || busy()} onPress={() => props.onModeChange("existing")}><ButtonText>Use existing CLI</ButtonText></PillButton> : null}
        </>}
      </View>} />
    {authenticated() ? <>{rule()}<View class="flex-row justify-end px-4 py-1"><ChatGptUsageButton api={props.api} /></View></> : null}
    {logoutWarning() ? <>{rule()}<View class="px-4 py-2"><Text role="alert" class="text-xs text-muted-foreground">{logoutWarning()}</Text></View></> : null}
    {showFallback() ? <>{rule()}<View testID="Sign-in fallback" class="gap-3 px-4 py-3">
      <View accessibilityLabel="Having trouble signing in?" accessibilityState={{ expanded: helpOpen() }} role="button" onPress={() => helpOpen.update((open) => !open)} class="flex-row items-center gap-1.5">
        <Text class="text-xs leading-relaxed text-muted-foreground">Having trouble signing in?</Text>
        <View class={helpOpen() ? "rotate-90" : ""}><UiIcon name="chevron-right" size={12} /></View>
      </View>
      {helpOpen() ? <View class="w-full gap-3 border-t border-border-50 pt-3">
        <Text class="text-xs leading-relaxed text-muted-foreground">If sign-in doesn't return to R3 Code, paste the URL from the final localhost page.</Text>
        <View class="flex-row items-center gap-2">
          <DraftInput label="ChatGPT sign-in redirect URL" masked disabled={pending() || props.readOnly} value={callbackValue()} placeholder="Paste the URL from the sign-in tab" class="min-w-0 flex-1"
            onCommit={(value) => callback.set({ flowId: auth()?.flowId ?? "", value })} />
          <PillButton label="Connect" disabled={pending() || props.readOnly || !callbackValue().trim()} onPress={() => void submitCallback()}><ButtonText>Connect</ButtonText></PillButton>
        </View>
        <View accessibilityLabel="Try sign-in in your browser" role="button" onPress={() => props.api.openExternal(pageUrl() as string)} class="h-7 flex-row items-center gap-1.5 self-start rounded-md px-2 hover:bg-accent-50">
          <Text class="text-xs text-muted-foreground">Try sign-in in your browser</Text><UiIcon name="external-link" size={14} />
        </View>
      </View> : null}
    </View></> : null}
    {settingsError() ? <>{rule()}<View class="px-4 py-2"><Text role="alert" class="text-xs text-destructive-foreground">{settingsError()}</Text></View></> : null}
  </View>;
}

/** CodexSignInDescription: the sign-in line, a "Having trouble signing in?" toggle once the page is open. */
export function CodexSignInDescription(props: { label?: string; expanded?: boolean; onToggle?: () => void }) {
  const label = () => props.label ?? "Complete sign-in in your browser.";
  if (!props.onToggle) return <Text class="text-xs leading-relaxed text-muted-foreground">{label()}</Text>;
  return <View role="button" accessibilityLabel="Having trouble signing in?" accessibilityState={{ expanded: props.expanded === true }} onPress={props.onToggle} class="flex-row items-center gap-1.5 self-start rounded-sm">
    <Text class="text-xs leading-relaxed text-muted-foreground">{label()}</Text>
    <View class={props.expanded ? "rotate-90" : ""}><UiIcon name="chevron-right" size={12} /></View>
  </View>;
}

function CodexReady() {
  return <View class="flex-row items-center gap-1.5" accessibilityLabel="Ready"><Icon name="check" size={14} tint={token("success-foreground")} /><Text class="text-xs font-medium text-success-foreground">Ready</Text></View>;
}

/** CodexWelcomeCard: the onboarding card (OpenAI mark, title over description, controls on the right, a footer below). */
export function CodexWelcomeCard(props: { title: string; description: any; control?: any; secondaryControl?: any; children?: any }) {
  const footer = () => (Array.isArray(props.children) ? props.children : [props.children]).filter((child) => child !== null && child !== undefined && child !== false);
  return <View class="rounded-lg border border-border bg-background px-4 py-4" testID="Codex welcome card">
    <View class="flex-row flex-wrap items-center gap-3">
      <ProviderIconView driver="codex" name="OpenAI" size={20} />
      <View class="min-w-0 flex-1">
        <Text class="text-sm font-medium text-foreground">{props.title}</Text>
        <View class="mt-0.5">{typeof props.description === "string" ? <Text class="text-xs leading-relaxed text-muted-foreground">{props.description}</Text> : props.description}</View>
      </View>
      {props.control || props.secondaryControl ? <View class="shrink-0 flex-row flex-wrap items-center justify-end gap-2">{props.secondaryControl ?? null}{props.control ?? null}</View> : null}
    </View>
    {footer().length > 0 ? <View class="ml-8 mt-2 flex-row flex-wrap items-center gap-2">{footer()}</View> : null}
  </View>;
}

/** CodexSetupSection's existing-CLI onboarding card: what the installed Codex CLI reports, or the two ways in. */
export function CodexExistingWelcomeCard(props: { provider: ProviderView | undefined; displayName?: string; enabled: boolean; readOnly: boolean; existingCliDisabled?: boolean; onModeChange: (mode: "managed" | "existing") => void }) {
  const state = () => { const p = props.provider; if (!p) return "checking"; if (!p.enabled || p.status === "disabled") return "disabled"; if (!p.installed && p.status === "warning" && p.auth.status === "unknown") return "checking"; if (!p.installed) return "install"; if (p.auth.status === "unauthenticated") return "signIn"; return p.status === "ready" ? "ready" : "attention"; };
  const ready = () => props.enabled && state() === "ready";
  const checking = () => state() === "checking";
  const authenticated = () => props.provider?.auth.status === "authenticated";
  const headline = () => providerSummary(props.provider).headline;
  const description = (): any => ready()
    ? props.provider?.auth.email?.trim()
      ? <View class="flex-row flex-wrap items-center"><Text class="text-xs text-muted-foreground">Signed in as </Text><RedactedSensitiveText value={props.provider.auth.email} ariaLabel="Toggle account email visibility" revealTooltip="Click to reveal email" hideTooltip="Click to hide email" /><Text class="text-xs text-muted-foreground">.</Text></View>
      : "Connected with your Codex CLI."
    : checking() ? "Checking your Codex CLI..." : props.provider?.installed ? headline() : "Code with your ChatGPT subscription.";
  return () => <CodexWelcomeCard title={props.displayName || props.provider?.displayName || "Codex"} description={description()}
    control={ready() ? <CodexReady /> : checking() ? <Text class="text-xs text-muted-foreground">Checking...</Text> : authenticated() ? <Text class="text-xs text-muted-foreground">{headline()}</Text>
      : <ChatGptButton disabled={props.readOnly} onPress={() => props.onModeChange("managed")} />}
    secondaryControl={!authenticated() && !ready() && !checking()
      ? <PillButton label="Use existing CLI" variant="ghost" disabled={props.existingCliDisabled === true} onPress={() => props.onModeChange("existing")}><ButtonText tone="muted">Use existing CLI</ButtonText></PillButton> : null} />;
}

/** CodexManagedRuntimeFields: where T3 Code put Codex and its home directories, read-only. */
export function CodexManagedRuntimeFields(props: { api: ProviderApi; instanceId: string; provider: ProviderView | undefined }) {
  const install = signal<ProviderInstallState | null>(null);
  const failed = signal(false);
  effect(() => {
    const id = props.instanceId;
    install.set(null); failed.set(false);
    return props.api.setup.subscribeInstall(id, (state) => install.set(state), () => failed.set(true));
  });
  const paths = () => props.provider?.runtimePaths;
  const field = (label: string, value: string, placeholder: string) => <View class="w-80"><DraftInput label={label} value={value} placeholder={placeholder} disabled class="w-full" onCommit={() => {}} /></View>;
  return <>
    <Row divider={false} title="Binary path" description="Selected by R3 Code." control={field("Codex binary path", install()?.executablePath ?? "", failed() ? "Could not read runtime path" : "Not installed")} />
    <Row title="CODEX_HOME path" description="Shared Codex config, sessions, and state." control={field("Codex home path", paths()?.homePath ?? "", "Unavailable")} />
    <Row title="Shadow home path" description={paths()?.shadowHomePath ? "Account-specific home sharing the Codex state above." : "This instance uses the shared Codex home directly."}
      control={field("Codex shadow home path", paths()?.shadowHomePath ?? "", paths() ? "Not used" : "Unavailable")} />
  </>;
}

const randomId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** AddCodexAccountDialog: names a new managed Codex instance, then runs its sign-in in the dialog. */
export function AddCodexAccountDialog(props: { api: ProviderApi; canManage: boolean; onClose: () => void; onAccountCreated?: (instanceId: string, displayName: string) => void }) {
  useOverlayOpen(true, "add chatgpt account");
  const name = signal("Personal");
  const instanceId = signal<string | null>(null);
  const pending = signal(false);
  const error = signal("");
  const displayName = () => `ChatGPT - ${name().trim()}`;
  const provider = () => { const id = instanceId(); return id === null ? undefined : props.api.providers().find((candidate) => candidate.instanceId === id); };
  const connected = () => provider()?.auth.status === "authenticated";
  effect(() => { if (connected()) props.onClose(); });

  async function createAccount() {
    if (pending() || !name().trim() || !props.canManage) return;
    pending.set(true); error.set("");
    const id = `codex_${randomId()}`;
    try {
      await props.api.mutate({ operation: "create", instanceId: id, instance: { driver: "codex", displayName: displayName(), enabled: true, config: { enabled: true, setupMode: "managed" } } });
      props.onAccountCreated?.(id, displayName());
      instanceId.set(id);
    } catch (cause) { error.set(message(cause, "Could not add the account.")); }
    finally { pending.set(false); }
  }
  return <Dialog open animation="fade" onCancel={props.onClose} onOpenChange={({ open }) => { if (!open) props.onClose(); }} closeOnBackdropPress={false} testID="Add ChatGPT account dialog"
    backdropStyle={dialogBackdropStyle()} style={[{ margin: "auto", width: 768, maxWidth: "92%" }, dialogPopupMotion()]}>
    <View class="relative w-full flex-col overflow-hidden rounded-2xl border border-border bg-background" onPress={keepPressInDialog}>
      <DialogCloseButton onClose={props.onClose} />
      <View class="gap-1 px-6 pt-5 pb-4">
        <Text class="text-lg font-semibold text-foreground">{instanceId() ? displayName() : "Add ChatGPT account"}</Text>
        <Text class="text-sm text-muted-foreground">Each account has its own Codex instance and sign-in. Choose the other account on the sign-in page.</Text>
      </View>
      <View class="gap-3 px-6 py-5">
        {instanceId() ? (provider()?.setup
          ? <CodexManagedSetup api={props.api} instanceId={instanceId() as string} provider={provider()} enabled readOnly={!props.canManage} autoStart allowExistingCli={false} divider={false}
            onModeChange={() => {}} onSignInCancelled={props.onClose} />
          : <Row divider={false} title="Codex runtime" description="Preparing managed setup." />)
          : <View class="gap-3">
            <Row divider={false} title="Account name" description="Shown in the provider list and model picker."
              control={<DraftInput label="Account name" value={name()} disabled={pending()} placeholder="e.g. Personal or Work" class="w-56" onCommit={(next) => name.set(next)} />} />
            <MultipleAccountsNote api={props.api} driver="codex" />
            {error() ? <ErrorText>{error()}</ErrorText> : null}
          </View>}
      </View>
      <View class="flex-row items-center justify-end gap-2 px-6 pb-5">
        {instanceId() ? <PillButton label="Finish later" onPress={props.onClose}><ButtonText>Finish later</ButtonText></PillButton> : <>
          <PillButton label="Cancel add ChatGPT account" disabled={pending()} onPress={props.onClose}><ButtonText>Cancel</ButtonText></PillButton>
          <PillButton label="Continue adding account" variant="primary" disabled={pending() || !name().trim() || !props.canManage} onPress={() => void createAccount()}><ButtonText tone="primary">{pending() ? "Adding account…" : "Continue"}</ButtonText></PillButton>
        </>}
      </View>
    </View>
  </Dialog>;
}
