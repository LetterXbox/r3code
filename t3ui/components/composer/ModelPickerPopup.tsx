// The model picker popover, ported from ModelPickerContent.tsx / ModelPickerSidebar.tsx /
// ModelListRow.tsx: a provider sidebar (Favorites first), a "Search models..." field, and
// model rows with a selected check and a favourite star. What it lists follows pickerModel.ts.
import { cleanup, effect, keymap, signal, Scroll, Text, token, View } from "nsh";
import { Input } from "nsh/base";
import type { InputRef, ViewRef } from "nsh";
import type { AvailableModel } from "../../store";
import { composerDraft, openSettings, openThread, openThreadModelSelection, providerStatuses, rawProviderRecords } from "../../store";
import { requestProviderSelection } from "../../pages/settings/providers/data";
import { isUltrathinkPrompt, ultrathinkPromptControlled, withPromptUltrathink } from "./modelTraits";
import { getProviderStatusMessage } from "./providerStatusLogic";
import { providerSetupEntries, setupActionLabel, shouldOfferModelPickerSetup, updateRequiredNotices } from "./modelPickerNotices";
import { serverSettings } from "../../pages/settings/settingsState";
import { ProviderIconView } from "../../pages/settings/providers/ui";
import { accentForeground, instanceInitials } from "../../pages/settings/providers/logic";
import { ComposerIcon } from "./ComposerIcon";
import { RailIndicator } from "../motion/Motion";
import { EffortColumn } from "./EffortColumn";
import type { EffortBridge } from "./EffortColumn";
import { effortFocusPending } from "./composerControls";
import { favoriteKeys, toggleFavorite } from "./favorites";
import type { Descriptor } from "./modelTraits";
import { providerMetaFor } from "./providerCatalog";
import { moveHighlight } from "./modelPickerLogic";
import { groupModels } from "../thread/modelGroups";
import { applyProviderLock, buildPickerInstances, displayModelName, describeUnavailableInstance, listFor, lockedInstanceTooltip, modelKeyOf, resolvePickerSelectedModel, startTab } from "./pickerModel";
import type { PickerInstance, PickerModel, PickerTab, ProviderLock } from "./pickerModel";
import { modelShortName } from "./modelShortName";
import { Popup } from "./Popover";
import { overGlass, tokenAlpha, tokenTint } from "./tokenColor";
import { registerCommands, shortcutLabel } from "../../commands/registry";
import type { Content } from "./Popover";

/** Instances for the picker: the server's provider snapshots when they cover `models`, else one instance per provider in `models`. */
export function pickerInstancesFor(models: AvailableModel[]): PickerInstance[] {
  const records = rawProviderRecords();
  const covered = models.length > 0 && models.every((item) => records.some((record) => record.instanceId === item.provider));
  if (covered) {
    const allow = new Set(models.map((item) => `${item.provider}:${item.model}`));
    const selected = openThreadModelSelection();
    // The unlisted selection passes the allow list so appendUnavailableSelection can show it as unavailable.
    return buildPickerInstances(records, serverSettings(), allow, selected, openThread()?.projectId ?? null);
  }
  const groups = groupModels(models);
  const count = (driver: string) => groups.filter((group) => (providerMetaFor(group.provider)?.driver ?? models.find((item) => item.provider === group.provider)?.driver ?? group.provider) === driver).length;
  return groups.map((group): PickerInstance => {
    const meta = providerMetaFor(group.provider);
    const driver = meta?.driver ?? models.find((item) => item.provider === group.provider)?.driver ?? group.provider;
    return {
      instanceId: group.provider, driver, displayName: group.label, accentColor: meta?.accentColor ?? null, ready: true,
      showBadge: count(driver) > 1 || !!meta?.accentColor, badge: instanceInitials(group.label),
      models: group.models.map((entry): PickerModel => ({ instanceId: group.provider, slug: entry.model, name: entry.label, isLegacy: false, isNew: false, isUnavailable: false, subProvider: null })),
    };
  });
}

/** The provider's mark with the instance badge (initials) the web draws when instances need telling apart. */
function InstanceMark(props: { instance: PickerInstance; size: number; small: boolean; ring: () => string }) {
  const accent = props.instance.accentColor;
  return (
    <View class="relative items-center justify-center" style={{ width: props.size, height: props.size }}>
      <ProviderIconView driver={props.instance.driver} instanceId={props.instance.instanceId} name={props.instance.displayName} accentColor={accent} size={props.size} />
      {props.instance.showBadge ? (
        <View
          class={`absolute items-center justify-center rounded-full border ${props.small ? "h-3 min-w-3 px-0.5" : "h-3.5 min-w-3.5 px-0.5"}`}
          style={{ right: props.small ? -2 : 0, bottom: props.small ? -2 : 0, backgroundColor: accent ?? String(token("card")), borderColor: props.ring() }}
        >
          <Text class={props.small ? "text-[8px] font-semibold" : "text-[9px] font-semibold"} style={{ color: accent ? accentForeground(accent) : String(token("muted-foreground")) }}>{props.instance.badge}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function ModelPickerPopup(props: {
  anchor: () => ViewRef | null;
  models: () => AvailableModel[];
  selected: () => AvailableModel | null;
  onSelect: (provider: string, model: string) => void;
  onClose: () => void;
  /** Set by the caller's <Presence> while the popup plays its 150ms exit. */
  closing?: () => boolean;
  footer?: Content;
  /** Docks the effort column beside the list: the selected model's real option descriptors. */
  descriptors?: () => Descriptor[];
  onTraitChange?: (id: string, value: string | boolean) => void;
  /** Where "Open provider setup" goes; by default Settings > Providers with that provider selected. */
  onOpenProviderSetup?: (instanceId: string) => void;
  /** A started thread's provider (lockedProvider / lockedContinuationGroupKey): other providers are listed last, disabled. */
  lock?: () => ProviderLock | null;
  /** A draft's multiple-model selection (ComposerModelPicker onToggleModel): Shift+click adds or removes a model, and
   * every picked model shows the check. */
  multiple?: { selected: () => { provider: string; model: string }[] | null; toggle: (provider: string, model: string) => void };
  /** Laid out in place (no popup), for a picker inside a dialog. */
  inline?: boolean;
  /** getModelDisabledReason: why a model row cannot be picked (it is dimmed with this as its tooltip), or null. */
  disabledReason?: (instanceId: string, slug: string) => string | null;
  /** Closes the list column inside the popup's fixed height (the ChatGPT plan control). */
  listFooter?: Content;
}) {
  const docked = () => props.descriptors !== undefined;
  const instances = () => applyProviderLock(pickerInstancesFor(props.models()), props.lock?.() ?? null);
  // A locked picker opens on the active instance, not Favorites (ModelPickerContent.tsx selectedInstanceId).
  const tab = signal<PickerTab>(props.lock?.() ? (props.selected()?.provider ?? startTab(instances(), null, new Set())) : startTab(instances(), props.selected()?.provider ?? null, favoriteKeys()));
  const query = signal("");
  const expandedLegacy = signal(props.selected() ? instances().some((instance) => instance.models.some((model) => model.isLegacy && modelKeyOf(model) === `${props.selected()!.provider}:${props.selected()!.model}`)) : false);
  const hovered = signal<string | null>(null);
  const hoveredProvider = signal<string | null>(null);
  // Each provider row's top in the rail: the selected-provider bar follows the selection (ModelPickerSidebar.tsx:88-93).
  const railTops = signal<Record<string, number>>({});
  const searchFocused = signal(false);
  const searching = () => query().trim().length > 0;
  // Where the keyboard is (ModelPickerContent / ModelPickerSidebar / ComposerModelEffort): the search field, the provider rail or the
  // docked effort column. Left, Right and Up/Down mean something different in each.
  const zone = signal<"search" | "sidebar" | "effort">("search");
  const caret = signal(0);
  let searchInput: InputRef | null = null;
  const railRefs = new Map<string, ViewRef>();
  const effortBridge: { current: EffortBridge | null } = { current: null };
  const focusSearch = () => { zone.set("search"); searchInput?.focus(); };
  const disabledFor = (model: { instanceId: string; slug: string }): string | null => props.disabledReason?.(model.instanceId, model.slug) ?? null;
  const list = () => listFor(instances(), tab(), query(), favoriteKeys(), expandedLegacy());
  const shown = () => list().rows;
  // selectableUnavailableInstanceIds: an instance that is not ready stays reachable when it is the active one or offers setup.
  const reachableUnavailable = (instance: PickerInstance): boolean => {
    if (instance.ready) return false;
    if (props.selected()?.provider === instance.instanceId) return true;
    const status = providerStatuses().find((entry) => entry.instanceId === instance.instanceId);
    return status !== undefined && shouldOfferModelPickerSetup(status, instance);
  };
  const railSelectable = (instance: PickerInstance): boolean => !instance.lockedOut && (instance.ready || reachableUnavailable(instance));
  const isSelected = (model: PickerModel) => {
    const picked = props.multiple?.selected();
    if (picked) return picked.some((item) => item.provider === model.instanceId && item.model === model.slug);
    const current = props.selected();
    if (current?.provider !== model.instanceId) return false;
    const instance = instances().find((entry) => entry.instanceId === model.instanceId);
    return resolvePickerSelectedModel(instance?.driver, current.model, instance?.models ?? [])?.slug === model.slug;
  };
  // The first highlighted row is the selected model when the list has it (autoHighlight), else the first.
  const defaultHighlight = () => Math.max(0, shown().findIndex(isSelected));
  const highlight = signal(defaultHighlight());
  // Docked, the popup stays open so the effort column can follow the pick; Escape or an outside press closes it.
  const pick = (instanceId: string, slug: string): boolean => {
    if (disabledFor({ instanceId, slug })) return false;
    props.onSelect(instanceId, slug);
    if (!docked()) props.onClose();
    // The column renders the new model's levels on commit; picking moves the focus to them (handleInstanceModelChange).
    else requestAnimationFrame(() => { if (effortBridge.current?.focus("levels")) zone.set("effort"); });
    return true;
  };
  const instanceOf = (instanceId: string) => instances().find((instance) => instance.instanceId === instanceId);
  // modelPicker.previousProvider / nextProvider step the provider sidebar; modelPicker.jump.N picks the Nth row.
  // handleSelectInstance: the search field takes the focus back after a provider is chosen.
  const selectTab = (next: PickerTab) => { tab.set(next); query.set(""); caret.set(0); highlight.set(Math.max(0, listFor(instances(), next, "", favoriteKeys(), expandedLegacy()).rows.findIndex(isSelected))); requestAnimationFrame(focusSearch); };
  const stepProvider = (direction: 1 | -1) => {
    const tabs: PickerTab[] = ["favorites", ...instances().filter(railSelectable).map((instance) => instance.instanceId)];
    const at = tabs.indexOf(tab());
    selectTab(tabs[(at < 0 ? (direction === 1 ? 0 : tabs.length - 1) : (at + direction + tabs.length) % tabs.length)] ?? "favorites");
  };
  // modelJumpModelKeys: a row the thread cannot take is skipped by the jump keys and their labels.
  const jumpRows = () => shown().filter((row) => !disabledFor(row)).slice(0, 9);
  const jump = (index: number) => {
    const row = jumpRows()[index];
    if (row) pick(row.instanceId, row.slug);
  };
  registerCommands({
    "modelPicker.previousProvider": () => stepProvider(-1),
    "modelPicker.nextProvider": () => stepProvider(1),
    ...Object.fromEntries(Array.from({ length: 9 }, (_, n) => [`modelPicker.jump.${n + 1}`, () => jump(n)])),
  });
  const jumpLabel = (model: PickerModel) => {
    const index = jumpRows().findIndex((row) => modelKeyOf(row) === modelKeyOf(model));
    return index >= 0 ? shortcutLabel(`modelPicker.jump.${index + 1}`, { modelPickerOpen: true, isDesktop: true }) : null;
  };
  // Rows plus the trailing "Show more" row are all highlightable.
  const slots = () => shown().length + (list().hiddenLegacy > 0 || list().expanded ? 1 : 0);
  effect(() => {
    const length = slots();
    if (highlight() >= length) highlight.set(Math.max(0, length - 1));
  });
  // The rail's stops in drawing order: Favorites, then the providers that take a press.
  const railOrder = () => ["favorites", ...instances().filter(railSelectable).map((instance) => instance.instanceId)];
  let railFocus: string | null = null;
  const stepRail = (direction: 1 | -1) => {
    const order = railOrder();
    const at = order.indexOf(railFocus ?? tab());
    railRefs.get(order[Math.min(order.length - 1, Math.max(0, at + direction))] ?? "")?.focus();
  };
  // Shift+Tab or Left from empty search goes to the rail, on the selected provider (else the first that takes a press).
  const focusRail = () => {
    const target = railRefs.get(tab()) ?? railRefs.get(railOrder()[0] ?? "");
    if (target) { target.focus(); zone.set("sidebar"); }
  };
  effect(() => {
    const off = keymap.bind({
      up: () => { if (zone() === "effort") effortBridge.current?.step(-1); else if (zone() === "sidebar") stepRail(-1); else highlight.set(moveHighlight(highlight(), -1, slots())); },
      down: () => { if (zone() === "effort") effortBridge.current?.step(1); else if (zone() === "sidebar") stepRail(1); else highlight.set(moveHighlight(highlight(), 1, slots())); },
    }, { when: "always", repeat: true });
    return off;
  });
  // Left, Right and Shift+Tab by zone. Bound only where they mean something, so a caret keeps its arrows: Left only while the search
  // is empty, Right only with the caret at the end of the text.
  effect(() => {
    const where = zone();
    const bindings: Record<string, () => void> = {};
    if (where === "search") {
      if (showSidebar()) bindings["shift+tab"] = focusRail;
      if (showSidebar() && query().length === 0) bindings.left = focusRail;
      if (docked() && caret() >= query().length) bindings.right = () => {
        // The column shows the selected model's effort, so a highlighted model is picked first; the levels take the focus.
        const row = shown()[highlight()];
        if (row && !isSelected(row) && pick(row.instanceId, row.slug)) return;
        if (effortBridge.current?.focus("any")) zone.set("effort");
      };
    } else if (where === "sidebar") bindings.right = focusSearch;
    else if (where === "effort") {
      bindings.left = () => { if (!effortBridge.current?.left()) focusSearch(); };
      bindings.right = () => effortBridge.current?.right();
    }
    if (Object.keys(bindings).length === 0) return;
    return keymap.bind(bindings, { when: "always", repeat: true });
  });
  // Shift+Enter picks the highlighted model additively in a multiple-model draft (handleModelSelect additive).
  effect(() => {
    if (!props.multiple) return;
    return keymap.bind({ "shift+enter": () => { const row = shown()[highlight()]; if (row && !disabledFor(row)) props.multiple!.toggle(row.instanceId, row.slug); } }, { when: "always" });
  });
  // composer.effort aimed at the picker: once the docked column is up it takes the focus (takeOpenTarget "effort").
  effect(() => {
    if (!effortFocusPending()) return;
    effortFocusPending.set(false);
    if (docked()) requestAnimationFrame(() => { if (effortBridge.current?.focus("any")) zone.set("effort"); });
  });
  cleanup(() => effortFocusPending.set(false));
  // Providers that need setup say why and offer it; providers whose models need a newer CLI say which version.
  const setupEntries = () => providerSetupEntries({ instances: instances(), statuses: providerStatuses(), selectedInstanceId: tab(), searching: searching(), listEmpty: shown().length === 0 });
  const updateNotices = () => updateRequiredNotices({ instances: instances(), records: rawProviderRecords(), selectedInstanceId: tab(), searching: searching(), query: query() });
  const openSetup = (instanceId: string) => {
    props.onClose();
    if (props.onOpenProviderSetup) { props.onOpenProviderSetup(instanceId); return; }
    requestProviderSelection(instanceId);
    openSettings("/settings/providers");
  };
  // The rail icon's tooltip: why a provider is unavailable first, else why this thread cannot switch to it.
  const sidebarTooltip = (item: PickerInstance): string => {
    const status = providerStatuses().find((entry) => entry.instanceId === item.instanceId);
    if (!item.ready) return describeUnavailableInstance(item.displayName, status);
    return item.lockedOut ? lockedInstanceTooltip(item.displayName) : describeUnavailableInstance(item.displayName, status);
  };
  const showSidebar = () => !searching() && instances().length > 0;
  const rowFill = (key: string, index: number) => (hovered() === key || highlight() === index ? { backgroundColor: tokenAlpha("foreground", 0.09) } : undefined);
  const hasLegacyRow = () => list().hiddenLegacy > 0 || list().expanded;

  // Fit the tallest tab so switching tabs never resizes the popup and moves the rail under the cursor (tallestTabUnits): rows
  // are 8 units (4pt each) with half a unit between them, plus 15.5 units of search box and list padding and a 1pt border.
  // While searching the height stays what it was before the first letter.
  const measuredHeight = signal(0);
  const tallestTabPoints = () => {
    const rowsOf = (tabId: PickerTab) => { const result = listFor(instances(), tabId, "", favoriteKeys(), false); return result.rows.length + (result.hiddenLegacy > 0 ? 1 : 0); };
    const counts = ["favorites", ...instances().map((instance) => instance.instanceId)].map(rowsOf);
    const rows = Math.max(0, ...counts);
    const units = rows === 0 ? 0 : rows * 8 + (rows - 1) * 0.5;
    return Math.min((units + 15.5) * 4 + 1, 346);
  };
  const containerStyle = () => (docked() ? undefined : searching() && measuredHeight() > 0 ? { height: measuredHeight() } : { minHeight: tallestTabPoints() });

  // In a dialog a popup does not take presses (nsh-runtime-bugs.md #8): `inline` lays the same list out in the
  // dialog's own tree under its trigger.
  const body = (
      <View>
        <View class={docked() ? "h-[346px] flex-row" : "max-h-[346px] flex-row"} style={containerStyle()} onLayout={(event: { bounds: { size: { height: number } } }) => { if (!searching()) measuredHeight.set(event.bounds.size.height); }}>
          <View class="w-[360px] flex-row">
          {showSidebar() ? (
            <View class="w-11 gap-1 p-1" style={{ backgroundColor: overGlass("muted", 0.3) }} accessibilityLabel="Providers">
              <View
                class="aspect-square w-full items-center justify-center rounded-md transition-colors duration-150 ease-in-out"
                style={hoveredProvider() === "favorites" ? { backgroundColor: tokenAlpha("foreground", 0.1) } : undefined}
                onLayout={(event: { bounds: { origin: { y: number } } }) => railTops.update((tops) => ({ ...tops, favorites: event.bounds.origin.y }))}
                onMouseEnter={() => hoveredProvider.set("favorites")}
                onMouseLeave={() => { if (hoveredProvider() === "favorites") hoveredProvider.set(null); }}
                onPress={() => selectTab("favorites")}
                ref={(node: ViewRef | null) => { if (node) railRefs.set("favorites", node); }}
                onFocus={() => { railFocus = "favorites"; zone.set("sidebar"); }}
                accessibilityLabel="Favorites"
                role="button"
              >
                <ComposerIcon name="star-filled" size={20} tint={tokenTint("foreground")} />
              </View>
              <View class="h-px bg-border-70" />
              <Each of={instances()} key={(item) => item.instanceId}>
                {(item) => (
                  <View
                    class={`aspect-square w-full items-center justify-center rounded-md transition-colors duration-150 ease-in-out ${railSelectable(item()) ? "" : "opacity-50"}`}
                    style={hoveredProvider() === item().instanceId && railSelectable(item()) ? { backgroundColor: tokenAlpha("foreground", 0.1) } : undefined}
                    onLayout={(event: { bounds: { origin: { y: number } } }) => railTops.update((tops) => ({ ...tops, [item().instanceId]: event.bounds.origin.y }))}
                    onMouseEnter={() => hoveredProvider.set(item().instanceId)}
                    onMouseLeave={() => { if (hoveredProvider() === item().instanceId) hoveredProvider.set(null); }}
                    onPress={() => { if (railSelectable(item())) selectTab(item().instanceId); }}
                    ref={(node: ViewRef | null) => { if (node) railRefs.set(item().instanceId, node); }}
                    onFocus={() => { railFocus = item().instanceId; zone.set("sidebar"); }}
                    accessibilityLabel={sidebarTooltip(item())}
                    tooltip={sidebarTooltip(item())}
                    role="button"
                  >
                    <InstanceMark instance={item()} size={24} small={false} ring={() => hoveredProvider() === item().instanceId ? String(token("muted")) : tab() === item().instanceId ? String(token("background")) : overGlass("muted", 0.3)} />
                  </View>
                )}
              </Each>
              <RailIndicator top={() => { const top = railTops()[tab()]; return top === undefined ? null : top + 8; }} />
            </View>
          ) : null}
          <View style={{ backgroundColor: overGlass("muted", 0.4) }} class={`min-w-0 flex-1 ${showSidebar() ? "border-l border-border-70" : ""}`}>
            <View class="px-3 pt-2.5">
              <View
                class="h-8 flex-row items-center gap-1 border-b pb-1.5"
                style={{ borderColor: searchFocused() ? String(token("ring")) : tokenAlpha("border", 0.7) }}
              >
                <ComposerIcon name="search" size={16} />
                <Input
                  autoFocus
                  ref={(node: InputRef | null) => { searchInput = node; }}
                  value={query()}
                  onChange={(event) => { query.set(event.value); highlight.set(0); }}
                  onSelectionChange={(event) => caret.set(event.end)}
                  onFocus={() => { searchFocused.set(true); zone.set("search"); }}
                  onBlur={() => searchFocused.set(false)}
                  onSubmit={() => {
                    const row = shown()[highlight()];
                    if (row) { if (!disabledFor(row)) pick(row.instanceId, row.slug); }
                    else if (hasLegacyRow() && highlight() === shown().length) expandedLegacy.set(!expandedLegacy());
                  }}
                  placeholder="Search models..."
                  accessibilityLabel="Search models"
                  class="h-[26px] min-w-0 flex-1 bg-transparent text-sm text-foreground"
                />
              </View>
            </View>
            {shown().length === 0 && !hasLegacyRow() ? (
              setupEntries().length > 0 ? null : <View class="px-4 py-3"><Text class="text-sm text-muted-foreground">{!searching() && tab() === "favorites" ? "No favorites yet" : "No models found"}</Text></View>
            ) : (
              <Scroll class="min-h-0 flex-1">
                <View class="gap-0.5 pl-2 pr-px py-1.5">
                  <Each of={shown()} key={(row) => modelKeyOf(row)}>
                    {(row) => (
                      <View
                        class={`min-h-8 flex-row items-center gap-2 rounded-sm px-2 py-1 ${disabledFor(row()) ? "opacity-50" : ""}`}
                        style={disabledFor(row()) ? undefined : rowFill(modelKeyOf(row()), shown().findIndex((item) => modelKeyOf(item) === modelKeyOf(row())))}
                        onPress={(event: { modifiers?: { shift?: boolean } }) => { if (disabledFor(row())) return; if (props.multiple && event?.modifiers?.shift) props.multiple.toggle(row().instanceId, row().slug); else pick(row().instanceId, row().slug); }}
                        onMouseEnter={() => hovered.set(modelKeyOf(row()))}
                        onMouseLeave={() => { if (hovered() === modelKeyOf(row())) hovered.set(null); }}
                        accessibilityLabel={`${displayModelName(row())}, ${instanceOf(row().instanceId)?.displayName ?? row().instanceId}`}
                        accessibilityHint={disabledFor(row()) ?? undefined}
                        tooltip={disabledFor(row()) ?? undefined}
                        role="button"
                      >
                        {instanceOf(row().instanceId) ? <InstanceMark instance={instanceOf(row().instanceId)!} size={16} small ring={() => String(token("popover"))} /> : null}
                        <View class="min-w-0 flex-1 flex-row items-center gap-2">
                          <Text class="min-w-0 truncate text-sm text-foreground">{displayModelName(row())}</Text>
                          {isSelected(row()) ? <ComposerIcon name="check" size={14} tint={tokenTint("foreground")} /> : null}
                          {row().subProvider ? <Text class="min-w-0 truncate text-xs text-muted-foreground">{row().subProvider}</Text> : null}
                          {row().isNew ? <Text class="rounded border border-border px-0.5 text-3xs font-bold text-foreground">NEW</Text> : null}
                          {row().isUnavailable ? <View class="rounded-sm border border-border px-1"><Text class="text-xs font-medium text-muted-foreground">Unavailable</Text></View> : null}
                        </View>
                        <View class="flex-row items-center gap-1.5">
                          <View
                            class="size-6 items-center justify-center rounded-md"
                            onPress={() => { if (!disabledFor(row())) toggleFavorite(row().instanceId, row().slug); }}
                            accessibilityLabel={favoriteKeys().has(modelKeyOf(row())) ? "Remove from favorites" : "Add to favorites"}
                            tooltip={favoriteKeys().has(modelKeyOf(row())) ? "Remove from favorites" : "Add to favorites"}
                            role="button"
                          >
                            {/* ModelListRow: in Favorites every row is starred, so the star shows only on hover there. */}
                            {favoriteKeys().has(modelKeyOf(row())) && (tab() !== "favorites" || hovered() === modelKeyOf(row()) || highlight() === shown().findIndex((item) => modelKeyOf(item) === modelKeyOf(row())))
                              ? <ComposerIcon name="star-filled" size={12} tint={tokenTint("warning")} />
                              : !favoriteKeys().has(modelKeyOf(row())) && (hovered() === modelKeyOf(row()) || highlight() === shown().findIndex((item) => modelKeyOf(item) === modelKeyOf(row())))
                                ? <ComposerIcon name="star" size={12} />
                                : <View class="size-3" />}
                          </View>
                          {jumpLabel(row()) ? (
                            <View class="h-5 min-w-5 items-center justify-center rounded px-1" style={{ backgroundColor: tokenAlpha("foreground", 0.07) }}>
                              <Text class="text-xs font-medium text-muted-foreground">{jumpLabel(row())}</Text>
                            </View>
                          ) : null}
                        </View>
                      </View>
                    )}
                  </Each>
                  {hasLegacyRow() ? (
                    <View
                      class="min-h-8 flex-row items-center rounded-sm px-2 py-1"
                      style={rowFill("legacy", shown().length)}
                      onPress={() => expandedLegacy.set(!expandedLegacy())}
                      onMouseEnter={() => hovered.set("legacy")}
                      onMouseLeave={() => { if (hovered() === "legacy") hovered.set(null); }}
                      accessibilityLabel={list().expanded ? "Show less" : "Show more"}
                      role="button"
                    >
                      <Text class={`text-sm ${hovered() === "legacy" || highlight() === shown().length ? "text-foreground" : "text-muted-foreground"}`}>{list().expanded ? "Show less" : "Show more"}</Text>
                    </View>
                  ) : null}
                </View>
              </Scroll>
            )}
            {setupEntries().length > 0 ? (
              <Scroll class="max-h-44 shrink-0 border-t border-border-70" accessibilityLabel="Provider setup">
                <View class="p-2">
                  <Each of={setupEntries()} key={(entry) => entry.instance.instanceId}>{(entry) => (
                    <View class="px-1 py-1.5">
                      <Text class="text-xs leading-snug text-muted-foreground">{getProviderStatusMessage(entry().status)}</Text>
                      <View role="button" accessibilityLabel={setupActionLabel(setupEntries().length, entry().instance.displayName)} onPress={() => openSetup(entry().instance.instanceId)} class="mt-1 self-start rounded-sm hover:bg-accent-50">
                        <Text class="text-xs font-medium text-primary">{setupActionLabel(setupEntries().length, entry().instance.displayName)}</Text>
                      </View>
                    </View>
                  )}</Each>
                </View>
              </Scroll>
            ) : null}
            <Each of={updateNotices()} key={(entry) => entry.instanceId}>{(entry) => (
              <View class="shrink-0 flex-row flex-wrap items-baseline gap-x-1 border-t border-border-70 px-3 py-2" accessibilityLabel="Update required">
                <Text class="text-xs leading-snug text-muted-foreground">{entry().notice}</Text>
                <View role="button" accessibilityLabel="Provider settings" onPress={() => { props.onClose(); openSettings("/settings/providers"); }} class="rounded-sm hover:bg-accent-50"><Text class="text-xs font-medium text-primary">Provider settings</Text></View>
              </View>
            )}</Each>
            {props.listFooter ?? null}
          </View>
          </View>
          {props.descriptors ? <EffortColumn descriptors={() => withPromptUltrathink(props.descriptors!(), composerDraft())} ultrathinkInBody={() => ultrathinkPromptControlled(props.descriptors!(), composerDraft()) && isUltrathinkPrompt(composerDraft().replace(/^Ultrathink:\s*/i, ""))} modelLabel={() => selectedShortName(props.selected())} onChange={(id, value) => props.onTraitChange?.(id, value)} bridge={effortBridge} onFocusZone={() => zone.set("effort")} /> : null}
        </View>
        {props.footer ?? null}
      </View>
  );
  return props.inline ? <View class={`overflow-hidden rounded-lg border border-border-70 ${docked() ? "w-[552px]" : "w-[360px]"}`} style={{ backgroundColor: String(token("popover")) }} testID="model-picker-inline">{body}</View> : (
    <Popup animated closing={props.closing} anchor={props.anchor} onClose={props.onClose} placement="top" align="end" class={docked() ? "w-[552px]" : "w-[360px]"}>
      {body}
    </Popup>
  );
}

/** The effort column's header name: the trigger's short name ("Fable 5.2"), not the full label. */
export function selectedShortName(model: AvailableModel | null): string {
  if (!model) return "";
  const separator = model.label.indexOf(": ");
  const name = separator >= 0 ? model.label.slice(separator + 2) : model.label;
  return modelShortName(name, model.driver ?? providerMetaFor(model.provider)?.driver ?? null);
}
