// ChatGptSharingControl.tsx: the model picker's list footer for a Codex instance that runs on the user's ChatGPT plan
// ("Using ChatGPT plan", the speed notice as its tooltip, and a Manage usage button).
import { openUrl, Text, View } from "nsh";
import { ProviderIconView } from "../../pages/settings/providers/ui";
import { CHATGPT_USAGE_URL } from "../usage/usageResetCredits";
import { UsageIcon } from "../usage/UsageIcon";

export const CHATGPT_SPEED_NOTICE = "Fast and Ultrafast are unavailable with this ChatGPT connection. Use an existing Codex CLI login for speed options your account supports.";

/** usesChatGptSharing (shared usageLimits.ts) over a raw provider snapshot record. */
export function usesChatGptSharingRecord(record: Record<string, unknown> | null | undefined): boolean {
  const auth = record?.auth as { status?: unknown; subscriptionSharing?: unknown } | undefined;
  return auth?.status === "authenticated" && auth?.subscriptionSharing === true;
}

export function ChatGptSharingControl(props: { provider: () => Record<string, unknown> | null }) {
  return props.provider() !== null && usesChatGptSharingRecord(props.provider()) ? (
    <View class="shrink-0 flex-row items-center justify-between gap-4 border-t border-border-70 px-3 py-2" accessibilityLabel="ChatGPT plan">
      <View class="flex-row items-center gap-2 rounded-sm" tooltip={CHATGPT_SPEED_NOTICE} accessibilityLabel="Using ChatGPT plan" accessibilityHint={CHATGPT_SPEED_NOTICE}>
        <ProviderIconView driver="openai" name="OpenAI" size={14} />
        <Text class="text-xs text-muted-foreground">Using ChatGPT plan</Text>
      </View>
      <View role="button" accessibilityLabel="Manage usage" onPress={() => { void openUrl(CHATGPT_USAGE_URL); }} class="h-6 flex-row items-center gap-1.5 rounded-md px-2 hover:bg-accent">
        <Text class="text-xs text-muted-foreground">Manage usage</Text>
        <UsageIcon name="external-link" size={12} />
      </View>
    </View>
  ) : null;
}
