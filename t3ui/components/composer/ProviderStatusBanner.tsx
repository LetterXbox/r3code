// The provider status alert above the composer (ProviderStatusBanner.tsx).
import { signal, Text, View } from "nsh";
import { openSettings, refreshProviderStatuses } from "../../store";
import type { ProviderStatus } from "../../store";
import { ComposerIcon } from "./ComposerIcon";
import { scopeAllows } from "../../backend/sessionScopes";
import { requestProviderSelection } from "../../pages/settings/providers/data";
import { getProviderStatusMessage, hasProviderSetup, providerBannerTitle, providerName } from "./providerStatusLogic";
import { enterStyle } from "../motion/Motion";
import { fadeInStart } from "../motion/motionTokens";

export function ProviderStatusBanner(props: { status: () => ProviderStatus; onDismiss: () => void }) {
  const refreshing = signal(false);
  async function refresh() {
    if (refreshing()) return;
    refreshing.set(true);
    try { await refreshProviderStatuses({ instanceId: props.status().instanceId, refreshModels: true }); }
    catch { /* The banner stays; the next status push replaces it. */ }
    finally { refreshing.set(false); }
  }
  const isWarning = () => props.status().status === "warning";
  return (
    <View
      style={enterStyle(fadeInStart)}
      class={`mb-2 flex-row items-start gap-2 rounded-xl border px-3.5 py-3 ${isWarning() ? "border-warning bg-warning-surface" : "border-error bg-error-surface"}`}
      role="alert"
    >
      <ComposerIcon name="circle-alert" size={16} />
      <View class="min-w-0 flex-1 gap-1">
        <Text class="text-sm font-medium text-foreground">{providerBannerTitle(props.status())}</Text>
        <Text class="text-sm text-muted-foreground line-clamp-3" tooltip={getProviderStatusMessage(props.status())}>{getProviderStatusMessage(props.status())}</Text>
        <View class="flex-row flex-wrap items-center justify-end gap-3">
          {hasProviderSetup(props.status()) ? (
            <View onPress={() => { requestProviderSelection(props.status().instanceId); openSettings("/settings/providers"); }} accessibilityLabel="Open provider setup" role="button">
              <Text class="text-sm text-foreground">Open provider setup</Text>
            </View>
          ) : null}
          <View
            class="h-6 flex-row items-center rounded-md border border-border px-2"
            onPress={() => void refresh()}
            // server.refreshProviders needs orchestration:read.
            disabled={refreshing() || !scopeAllows("orchestration:read")}
            accessibilityLabel={`Refresh ${providerName(props.status())} provider status`}
            role="button"
          >
            <Text class="text-xs text-foreground">{refreshing() ? "Refreshing..." : "Refresh"}</Text>
          </View>
        </View>
      </View>
      <View
        class="size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
        onPress={props.onDismiss}
        accessibilityLabel={`Dismiss ${providerName(props.status())} provider ${props.status().status}`}
        role="button"
      >
        <ComposerIcon name="x" size={14} />
      </View>
    </View>
  );
}
