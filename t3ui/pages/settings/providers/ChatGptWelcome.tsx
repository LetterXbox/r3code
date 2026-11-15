// ChatGptWelcomeCoordinator.tsx: once per signed-in ChatGPT profile that shares its plan (usesChatGptSharing), a dialog
// says the plan is connected, with Manage usage and Continue. Acknowledged profiles are remembered under the web's key.
// This client holds one live connection, so the profiles are the connected environment's providers.
import { openUrl, signal, Storage, Text, View } from "nsh";
import { SettingsDialog } from "../../../components/SettingsDialog";
import { SettingsButton } from "../../../components/SettingsLayout";
import { liveProviderApi } from "./data";
import type { ProviderView } from "./logic";
import { serverEnvironment } from "../settingsState";

const STORAGE_KEY = "t3:chatgpt-sharing-welcome:v1";
const CHATGPT_USAGE_URL = "https://chatgpt.com/#settings/Usage";

export interface SharingProfile { key: string; environmentLabel: string; providerName: string }

/** usesChatGptSharing: an authenticated provider whose usage draws on the ChatGPT plan. */
export const usesChatGptSharing = (provider: Pick<ProviderView, "auth">) => provider.auth.status === "authenticated" && provider.auth.subscriptionSharing === true;

/** The profiles to welcome, keyed as the web keys them ([environment, instance, profile]). */
export function sharingProfiles(environmentId: string, environmentLabel: string, providers: readonly ProviderView[]): SharingProfile[] {
  return providers.filter(usesChatGptSharing).map((provider) => ({
    key: JSON.stringify([environmentId, provider.instanceId, provider.auth.email ?? "default"]),
    environmentLabel,
    providerName: provider.displayName ?? "Codex",
  }));
}

export function parseAcknowledged(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : [];
  } catch { return []; }
}

const acknowledged = signal<string[] | null>(null);
void Storage.getItem(STORAGE_KEY).then((raw) => acknowledged.set(parseAcknowledged(raw)), () => acknowledged.set([]));

export function ChatGptWelcomeHost(props: { profiles?: () => SharingProfile[] } = {}) {
  const profiles = () => props.profiles?.() ?? (liveProviderApi.live() ? sharingProfiles(String(serverEnvironment()?.environmentId ?? "primary"), liveProviderApi.environmentLabel(), liveProviderApi.providers()) : []);
  const next = () => { const seen = acknowledged(); return seen === null ? undefined : profiles().find((profile) => !seen.includes(profile.key)); };
  const dismiss = () => {
    const profile = next();
    if (!profile) return;
    const updated = [...(acknowledged() ?? []), profile.key];
    acknowledged.set(updated);
    void Storage.setItem(STORAGE_KEY, JSON.stringify(updated)).catch(() => undefined);
  };
  return () => next() ? (
    <SettingsDialog
      open
      onClose={dismiss}
      title="Your ChatGPT plan is connected"
      description="Eligible usage in R3 Code uses your ChatGPT plan. Manage your shared usage and any credit settings in ChatGPT."
      testID="ChatGPT plan connected"
      footer={
        <>
          <SettingsButton label="Manage usage" onPress={() => void openUrl(CHATGPT_USAGE_URL).catch(() => undefined)} />
          <SettingsButton label="Continue" tone="primary" onPress={dismiss} />
        </>
      }
    >
      <View><Text class="text-xs text-muted-foreground">{`${next()!.providerName} on ${next()!.environmentLabel}`}</Text></View>
    </SettingsDialog>
  ) : null;
}
