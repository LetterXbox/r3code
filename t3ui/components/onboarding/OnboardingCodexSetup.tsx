// WelcomePage.tsx OnboardingCodexSetup: Codex's "Set up" card on the Welcome page. The ChatGPT card and the CLI card stay
// one card, so either choice can be undone here. Choosing a mode saves it on the instance (one-instance upsert) and turns
// the agent on; "Use existing CLI" also opens the CLI's install or sign-in terminal.
import { signal, View } from "nsh";
import { CodexExistingWelcomeCard, CodexManagedSetup, readCodexSetupMode } from "../../pages/settings/providers/CodexSetup";
import { liveProviderApi, type ProviderApi } from "../../pages/settings/providers/data";
import { errorToast } from "../toast/toastState";
import { rawProviderRecords } from "../../store";
import { serverSettings } from "../../pages/settings/settingsState";
import { parseInstances, parseProvider } from "../../pages/settings/providers/logic";

export function OnboardingCodexSetup(props: { instanceId: string; readOnly: boolean; existingCliDisabled: boolean; onUseCliChange: (useCli: boolean) => void; api?: ProviderApi }) {
  const api = props.api ?? liveProviderApi;
  const requested = signal(false);
  // The Welcome list reads the store's provider records; the settings panel's config stream runs only while Settings is open.
  const provider = () => props.api ? api.providers().find((item) => item.instanceId === props.instanceId)
    : rawProviderRecords().map(parseProvider).find((item) => item?.instanceId === props.instanceId) ?? undefined;
  const instance = () => (props.api ? api.instances() : parseInstances((serverSettings() as Record<string, unknown> | null)?.providerInstances))[props.instanceId] ?? { driver: provider()?.driver ?? "codex", config: {} };
  const config = () => { const value = instance().config; return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {}; };
  const mode = () => readCodexSetupMode(config());
  const changeMode = (setupMode: "managed" | "existing") => {
    props.onUseCliChange(setupMode === "existing");
    if ((mode() === setupMode && provider()?.enabled === true) || props.readOnly) return;
    void api.mutate({ operation: "upsert", instanceId: props.instanceId, instance: { ...instance(), enabled: true, config: { ...config(), enabled: true, setupMode } } }).catch((cause) => {
      props.onUseCliChange(false);
      errorToast("Could not save Codex setup", cause instanceof Error ? cause.message : undefined);
    });
  };
  const displayName = () => instance().displayName ?? provider()?.displayName ?? undefined;
  return () => <View class="mt-2">{mode() === "existing"
    ? <CodexExistingWelcomeCard provider={provider()} displayName={displayName() ?? undefined} enabled={provider()?.enabled === true} readOnly={props.readOnly} existingCliDisabled={props.existingCliDisabled}
        onModeChange={(next) => { if (next === "managed") requested.set(true); changeMode(next); }} />
    : <CodexManagedSetup presentation="onboarding" api={api} instanceId={props.instanceId} provider={provider()} enabled={provider()?.enabled === true} readOnly={props.readOnly}
        displayName={displayName() ?? undefined} existingCliDisabled={props.existingCliDisabled} autoStart={requested()} onModeChange={changeMode} />}</View>;
}
