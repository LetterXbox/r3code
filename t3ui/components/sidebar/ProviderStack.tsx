// SidebarProviderStack: the provider marks at the right of a card. The current provider reads at
// opacity-60; earlier ones sit behind it, smaller and faded (size-3 opacity-35 grayscale); the current mark is size-3.5, the compact ProviderInstanceIcon. Nothing
// draws until the server's provider list names the current instance.
import { View } from "nsh";
import type { Thread } from "../../store";
import { ProviderIconView } from "../../pages/settings/providers/ui";
import { providerMetaFor, providerMetas } from "../composer/providerCatalog";
import { threadProviderStack } from "./threadProviders";

/** shouldShowInstanceBadge: two instances on one driver need their initials to tell them apart. */
function sharesDriver(instanceId: string): boolean {
  const driver = providerMetaFor(instanceId)?.driver;
  return driver !== undefined && [...providerMetas().values()].filter((meta) => meta.driver === driver).length > 1;
}

export function SidebarProviderStack(props: { thread: Thread }) {
  const stack = () => threadProviderStack(props.thread);
  const current = () => providerMetaFor(stack()[stack().length - 1] ?? "");
  return current() ? (
    <View class="shrink-0 flex-row items-center gap-1.5">
      {stack().slice(0, -1).map((id) => {
        const meta = providerMetaFor(id);
        return meta ? (
          <View accessibilityLabel={`${meta.displayName} provider`} style={{ opacity: 0.35, filter: "grayscale(1)" }}>
            <ProviderIconView driver={meta.driver} instanceId={id} name={meta.displayName} size={12} fillSlot />
          </View>
        ) : null;
      })}
      <View accessibilityLabel={`${current()!.displayName} provider`} style={{ opacity: 0.6 }}>
        <ProviderIconView
          driver={current()!.driver}
          instanceId={current()!.instanceId}
          name={current()!.displayName}
          accentColor={current()!.accentColor}
          size={14}
          fillSlot
          badge={sharesDriver(current()!.instanceId)}
        />
      </View>
    </View>
  ) : null;
}
