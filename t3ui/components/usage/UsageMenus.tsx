// The breadcrumb's environment and provider menus, ported from UsageEnvironmentFilter and
// UsageProviderFilter in UsagePage.tsx. Each opens inline under its trigger.
import { signal, Text, View } from "nsh";
import { createHover } from "../hoverReveal";
import { ProviderMark } from "./ProviderMark";
import type { ViewRef } from "nsh";
import { createAnchor, Popup } from "../composer/Popover";
import { UsageIcon } from "./UsageIcon";
import { MENU_ITEM_ICON_SIZE, MENU_ITEM_ROW_CLASS, MENU_SEPARATOR_CLASS } from "../menuStyles";
import { providerPresentation } from "./usageFormat";
import { environmentLabel, type UsageEnvironmentEntry, PROVIDER_ORDER, providerFilterLabel, selectedEnvironments } from "./usageSelection";
import {
  openUsageDialog, setAllEnvironments, setAllProviders, setEnvironmentChecked, setProviderChecked, usageEnvironmentList,
  usageEnvironmentSelection, usageHiddenProviders,
} from "./usageState";

type Open = "environment" | "provider" | null;
const open = signal<Open>(null);
export const closeUsageMenus = () => open.set(null);
export const usageMenuOpen = () => open();

function CheckItem(props: { name: string; checked: boolean; onPress: () => void; children: unknown }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.name}
      accessibilityState={{ checked: props.checked }}
      onPress={props.onPress}
      class={MENU_ITEM_ROW_CLASS}
    >
      <View class="size-4 items-center justify-center">{props.checked ? <UsageIcon name="check" size={MENU_ITEM_ICON_SIZE} /> : null}</View>
      {props.children as never}
    </View>
  );
}

/** MenuPopup: floats over the page beside its trigger (registered with the WebView occlusion by Popup); a press outside or Esc closes it. */
function Panel(props: { anchor: () => ViewRef | null; children: unknown }) {
  return (
    <Popup anchor={props.anchor} onClose={closeUsageMenus} placement="bottom" align="start" class="min-w-56">
      <View class="flex-col gap-px p-1">{props.children as never}</View>
    </Popup>
  );
}

function Separator() {
  return <View class={MENU_SEPARATOR_CLASS} />;
}

export function UsageEnvironmentMenu(props: {
  phase: (id: string) => string;
  showStatus: () => boolean;
  hasIssue: () => boolean;
  /** Selected environments are still scanning: "Totals are partial while selected environments scan." */
  partial?: () => boolean;
  /** Environments whose read failed, by id, with the reason (UsageCoverageNotice). */
  failures?: () => Record<string, string>;
}) {
  const envs = () => usageEnvironmentList();
  const label = () => environmentLabel(envs(), usageEnvironmentSelection());
  const checked = (id: string) => usageEnvironmentSelection() === null || usageEnvironmentSelection()!.has(id);
  const anchor = createAnchor();
  const hover = createHover();
  return (
    <View class="min-w-0">
      <View
        ref={anchor.ref}
        role="button"
        accessibilityLabel="Usage environments"
        onPress={() => open.update((current) => (current === "environment" ? null : "environment"))}
        class="h-7 flex-row items-center gap-1.5 rounded-md px-1.5 hover:bg-accent-50"
        {...hover.bind}
      >
        <Text class="min-w-0 truncate text-sm text-foreground">{label()}</Text>
        {props.showStatus() && props.hasIssue() ? <View accessibilityLabel="Some environments could not report usage"><UsageIcon name="circle-alert" size={14} /></View> : <View class={open() === "environment" || hover.hovered() ? "opacity-100 transition-opacity duration-150 ease-in-out" : "opacity-60 transition-opacity duration-150 ease-in-out"}><UsageIcon name="chevron-down" size={14} /></View>}
      </View>
      {open() === "environment" ? (
        <Panel anchor={anchor.anchor}>
          <CheckItem name="All environments" checked={usageEnvironmentSelection() === null} onPress={() => setAllEnvironments(usageEnvironmentSelection() !== null)}>
            <Text class="text-sm text-foreground">All environments</Text>
          </CheckItem>
          <Separator />
          <Each of={envs()} key={(env: UsageEnvironmentEntry) => env.id}>
            {(env) => (
              <CheckItem name={env().label} checked={checked(env().id)} onPress={() => setEnvironmentChecked(env().id, !checked(env().id))}>
                <View class="min-w-0 flex-1 flex-row items-center gap-3">
                  <Text class="min-w-0 flex-1 truncate text-sm text-foreground">{env().label}</Text>
                  {props.showStatus() ? <Text class={props.phase(env().id) === "Unavailable" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{props.phase(env().id)}</Text> : null}
                </View>
              </CheckItem>
            )}
          </Each>
          {envs().length === 0 ? <Text class="px-2 py-2 text-xs text-muted-foreground">No environments connected.</Text> : null}
          {props.showStatus() && props.partial?.() ? <Text class="px-2 py-2 text-xs text-muted-foreground">Totals are partial while selected environments scan.</Text> : null}
          {props.showStatus() && Object.keys(props.failures?.() ?? {}).length > 0 ? (
            <View class="flex-col gap-1 border-t border-border px-2 py-2">
              <Each of={selectedEnvironments(envs(), usageEnvironmentSelection()).filter((env) => props.failures?.()[env.id])} key={(env: UsageEnvironmentEntry) => env.id}>
                {(env) => <Text class="text-xs text-muted-foreground">{`${env().label}: ${props.failures?.()[env().id]}`}</Text>}
              </Each>
            </View>
          ) : null}
          <Separator />
          <View
            role="button"
            accessibilityLabel="Model prices"
            onPress={() => { closeUsageMenus(); openUsageDialog({ kind: "prices" }); }}
            class={MENU_ITEM_ROW_CLASS}
          >
            <UsageIcon name="sliders-horizontal" size={MENU_ITEM_ICON_SIZE} />
            <Text class="text-sm text-foreground">Model prices</Text>
          </View>
        </Panel>
      ) : null}
    </View>
  );
}

export function UsageProviderMenu() {
  const hidden = () => usageHiddenProviders();
  const anchor = createAnchor();
  const hover = createHover();
  return (
    <View class="min-w-0">
      <View
        ref={anchor.ref}
        role="button"
        accessibilityLabel="Usage providers"
        onPress={() => open.update((current) => (current === "provider" ? null : "provider"))}
        class="h-7 flex-row items-center gap-1.5 rounded-md px-1.5 hover:bg-accent-50"
        {...hover.bind}
      >
        <Text class="min-w-0 truncate text-sm text-foreground">{providerFilterLabel(hidden())}</Text>
        <View class={open() === "provider" || hover.hovered() ? "opacity-100 transition-opacity duration-150 ease-in-out" : "opacity-60 transition-opacity duration-150 ease-in-out"}><UsageIcon name="chevron-down" size={14} /></View>
      </View>
      {open() === "provider" ? (
        <Panel anchor={anchor.anchor}>
          <CheckItem name="All providers" checked={hidden().length === 0} onPress={() => setAllProviders(hidden().length !== 0)}>
            <Text class="text-sm text-foreground">All providers</Text>
          </CheckItem>
          <Separator />
          <Each of={PROVIDER_ORDER} key={(provider: string) => provider}>
            {(provider) => (
              <CheckItem name={providerPresentation(provider()).label} checked={!hidden().includes(provider())} onPress={() => setProviderChecked(provider(), hidden().includes(provider()))}>
                <View class="flex-row items-center gap-2">
                  <ProviderMark provider={provider()} size={14} />
                  <Text class="text-sm text-foreground">{providerPresentation(provider()).label}</Text>
                </View>
              </CheckItem>
            )}
          </Each>
        </Panel>
      ) : null}
    </View>
  );
}

export { selectedEnvironments };
