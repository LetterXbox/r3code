// ChatView's fallback-model notice (ComposerUsageLimits.tsx modelFallbackBannerItem) under the composer footer row:
// shown on an unsent draft that started on the fallback model because the default model's provider is out of usage,
// while the composer still holds that fallback and the user has not picked a model. "Use <default>" switches to the
// default model; X hides it for this provider's exhausted window (stored per environment, as useLocalStorage does).
import { effect, signal, Storage, Text, View } from "nsh";
import { backendUrl, draftModelPicked, isServerThread, newThreadFallback, openThread, rawProviderRecords, selectedModel, setSelectedModel, settingValue } from "../../store";
import { BannerActionButton, DismissButton } from "./BannerParts";
import { BannerIcon } from "./BannerIcon";
import { formatUpcomingTimestamp } from "./bannerLogic";
import { fallbackModelItem, fallbackWindowKey, modelNameIn } from "./fallbackModel";
import { asTimestampFormat } from "../thread/timestampFormat";

const dismissedKey = () => `t3code:fallback-notice-dismissed:${backendUrl()}`;
const dismissed = signal<string | null>(null);
let loadedFor: string | null = null;

export function FallbackModelNotice(props: { now?: () => number } = {}) {
  const minute = signal(Date.now());
  effect(() => { const timer = setInterval(() => minute.set(Date.now()), 60_000); return () => clearInterval(timer); });
  const now = props.now ?? (() => minute());
  effect(() => {
    const key = dismissedKey();
    if (loadedFor === key) return;
    loadedFor = key;
    void Storage.getItem(key).then((raw) => { if (loadedFor === key) dismissed.set(typeof raw === "string" && raw.length > 0 ? JSON.parse(raw) : null); }).catch(() => undefined);
  });
  const item = () => {
    const thread = openThread();
    if (!thread || isServerThread(thread.id) || draftModelPicked(thread.id)) return null;
    const { defaultSelection, resolution } = newThreadFallback(thread.projectId ?? null, now());
    const fallback = resolution.fallback;
    const fallbackSelection = resolution.selection;
    if (!fallback || !fallbackSelection || !defaultSelection) return null;
    const current = selectedModel();
    if (current && (current.provider !== fallbackSelection.instanceId || current.model !== fallbackSelection.model)) return null;
    const windowKey = fallbackWindowKey(fallback);
    if (windowKey === dismissed()) return null;
    const fallbackProvider = rawProviderRecords().find((entry) => entry.instanceId === fallbackSelection.instanceId);
    const format = asTimestampFormat(settingValue("timestampFormat"));
    return fallbackModelItem({
      fallbackModelName: modelNameIn(fallbackProvider, fallbackSelection.model),
      defaultProviderName: String(fallback.provider.displayName ?? fallback.provider.driver ?? fallback.provider.instanceId),
      defaultModelName: modelNameIn(fallback.provider, defaultSelection.model),
      resetsAt: fallback.resetsAt,
      formatUpcoming: (iso) => formatUpcomingTimestamp(iso, format, now()),
      onUseDefault: () => setSelectedModel(defaultSelection.instanceId, defaultSelection.model),
      onDismiss: () => { dismissed.set(windowKey); void Storage.setItem(dismissedKey(), JSON.stringify(windowKey)).catch(() => undefined); },
    });
  };
  return (
    <>
      {item() ? (
        <View testID="Fallback model notice" accessibilityLabel={item()!.title} class="mx-3 mt-2 min-w-0 flex-row items-center gap-1 rounded-2xl border border-border bg-card px-1 py-1.5">
          <View class="size-6 shrink-0 items-center justify-center"><BannerIcon name="gauge" size={12} /></View>
          <View class="min-w-0 flex-1 flex-row items-center gap-1">
            <Text class="min-w-0 shrink truncate text-xs font-medium text-foreground">{item()!.title}</Text>
            <Text class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item()!.description}</Text>
          </View>
          <View class="shrink-0 flex-row items-center gap-1">
            <BannerActionButton action={item()!.actions[0]!} surface="notice" />
            <DismissButton label={item()!.dismissLabel!} onPress={() => item()?.onDismiss?.()} />
          </View>
        </View>
      ) : null}
    </>
  );
}
