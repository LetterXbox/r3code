// SourceControlAppSignInSettings.tsx: the card above a provider's token form that signs in through the forge app
// by device code (a code to enter at the provider's page, then the server waits for the approval).
import { openUrl, Clipboard, signal, Text, token, View } from "nsh";
import { RedactedSensitiveText } from "./providers/RedactedText";
import { SettingsButton } from "../../components/SettingsLayout";
import { SettingsIcon } from "./SettingsIcon";
import { replaceServerSettings, serverSettings } from "./settingsState";
import { requestServer } from "./settingsSync";
import { APP_SIGN_INS, expiryTime, readSignInPrompt, readSignInSettings, signInView, signOutPatch, type SignInPrompt, type SignInState } from "./sourceControlSignIn";

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function InlineLink(props: { label: string; url: string }) {
  return (
    <View role="button" accessibilityLabel={props.label} onPress={() => void openUrl(props.url).catch(() => undefined)} class="flex-row items-center gap-1">
      <Text class="text-xs text-foreground underline">{props.label}</Text>
      <SettingsIcon name="external-link" size={12} tint={token("muted-foreground")} />
    </View>
  );
}

/** The device code, one cell per character, as GitHub prints it. */
function DeviceCode(props: { code: string }) {
  const cells = () => Array.from(props.code, (char, index) => ({ char, index }));
  return (
    <View class="flex-row items-center gap-1" accessibilityLabel={props.code}>
      <Each of={cells()} key={(cell) => cell.index}>
        {(cell) => cell().char === "-"
          ? <Text class="px-0.5 text-lg text-muted-foreground">-</Text>
          : (
            <View class="h-10 w-8 items-center justify-center rounded-md border border-border bg-background">
              <Text class="font-mono text-lg font-medium text-foreground">{cell().char}</Text>
            </View>
          )}
      </Each>
    </View>
  );
}

export function SourceControlAppSignIn(props: { kind: string; account: string | null; onChanged: () => void }) {
  const definition = APP_SIGN_INS[props.kind]!;
  const host = definition.hosts[0] ?? "";
  const state = signal<SignInState>({ status: "idle" });
  const copied = signal(false);
  const saved = () => readSignInSettings(serverSettings(), props.kind, host);
  const view = () => signInView({ signedIn: saved().signedIn, tokenOverrides: saved().tokenOverrides, account: props.account, state: state() });
  const waiting = (): SignInPrompt | null => { const current = state(); return !saved().signedIn && current.status === "waiting" ? current.prompt : null; };
  const input = { provider: props.kind, host };

  const signIn = async () => {
    state.set({ status: "starting" });
    let prompt: SignInPrompt | null;
    try {
      prompt = readSignInPrompt(await requestServer("sourceControl.signInStart", input));
    } catch (cause) {
      state.set({ status: "failed", message: message(cause) });
      return;
    }
    if (!prompt) {
      state.set({ status: "failed", message: "The server did not return a sign-in code." });
      return;
    }
    state.set({ status: "waiting", prompt });
    let failure: string | null = null;
    try {
      await requestServer("sourceControl.signInWait", input);
    } catch (cause) {
      failure = message(cause);
    }
    // A newer attempt, a cancel, or a sign-out owns the state by now.
    const current = state();
    if (current.status !== "waiting" || current.prompt !== prompt) return;
    state.set(failure === null ? { status: "idle" } : { status: "failed", message: failure });
    if (failure === null) props.onChanged();
  };
  const signOut = async () => {
    state.set({ status: "idle" });
    try {
      replaceServerSettings(await requestServer("server.updateSettings", { patch: signOutPatch(props.kind, saved().signIns, host) }));
      props.onChanged();
    } catch (cause) {
      state.set({ status: "failed", message: message(cause) });
    }
  };
  const cancel = () => {
    state.set({ status: "idle" });
    void requestServer("sourceControl.signInCancel", input).catch(() => undefined);
  };
  const act = () => (view().action === "sign-out" ? void signOut() : view().action === "cancel" ? cancel() : void signIn());
  const failed = () => state().status === "failed" && !saved().signedIn;

  return (
    <View class={`overflow-hidden rounded-xl border bg-card ${failed() ? "border-destructive-foreground" : "border-border"}`} testID={`${definition.appName} sign-in`}>
      <View class="flex-row items-center gap-3 p-3">
        <View class="size-10 shrink-0 items-center justify-center rounded-xl bg-primary">
          <Text class="text-sm font-bold text-primary-foreground">T3</Text>
          {saved().signedIn ? (
            <View class="absolute -right-1 -bottom-1 size-4 items-center justify-center rounded-full bg-success"><SettingsIcon name="check" size={10} tint="#ffffff" /></View>
          ) : null}
        </View>
        <View class="min-w-0 flex-1 gap-0.5">
          <Text class="text-sm font-medium text-foreground">{definition.appName}</Text>
          {saved().signedIn && props.account !== null && !saved().tokenOverrides ? (
            // The signed-in account stays redacted until revealed (SourceControlAppSignInSettings.tsx:163-171).
            <View class="flex-row items-center gap-1">
              <Text class="text-xs text-muted-foreground">Signed in as</Text>
              <RedactedSensitiveText value={props.account} ariaLabel="Signed-in GitHub account" revealTooltip="Show account" hideTooltip="Hide account" />
            </View>
          ) : <Text class="text-xs text-muted-foreground">{view().subtitle}</Text>}
        </View>
        <SettingsButton label={view().actionLabel} onPress={act} />
      </View>
      {waiting() ? (
        <View class="gap-4 border-t border-border bg-muted-40 px-3 py-4">
          <View class="flex-row items-center gap-2">
            <DeviceCode code={waiting()!.userCode} />
            <View role="button" accessibilityLabel="Copy code" class="size-6 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out" onPress={() => { void Clipboard.writeText(waiting()!.userCode); copied.set(true); }}>
              <SettingsIcon name={copied() ? "check" : "copy"} size={14} />
            </View>
          </View>
          <View class="items-end gap-2">
            <SettingsButton label="Copy code & open GitHub" onPress={() => { void Clipboard.writeText(waiting()!.userCode); void openUrl(waiting()!.verificationUri).catch(() => undefined); }} />
            <View class="flex-row items-center gap-1.5">
              <View class="size-1.5 rounded-full bg-warning" />
              <Text class="text-xs text-muted-foreground">{`Waiting for approval · code expires at ${expiryTime(waiting()!.expiresAt)}`}</Text>
            </View>
          </View>
        </View>
      ) : null}
      {saved().signedIn ? (
        <View class="flex-row flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-muted-40 px-3 py-2">
          <Text class="min-w-0 flex-1 text-xs text-muted-foreground">Reaches repositories in accounts and organizations that installed the app.</Text>
          <InlineLink label="Install on an organization" url={definition.installUrl} />
          <InlineLink label="Manage on GitHub" url={definition.revokeUrl} />
        </View>
      ) : null}
      {failed() ? (
        <View class="border-t border-destructive-foreground px-3 py-2"><Text class="text-xs text-destructive-foreground">{(state() as { message: string }).message}</Text></View>
      ) : null}
    </View>
  );
}
