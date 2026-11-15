// The per-model dialog and the Custom model prices editor, ported from UsageModelDialog.tsx and
// UsagePriceOverrides.tsx. Both draw over the Usage page as the web's dialogs do over the app.
import { FadeScroll } from "../FadeScroll";
import { computed, effect, keymap, signal, Text, untracked, View } from "nsh";
import { ProviderMark } from "./ProviderMark";
import { Tip } from "../../pages/settings/providers/ui";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { DialogInput as Input } from "../DialogInput";
import { Icon } from "../Icons";
import { UsageIcon } from "./UsageIcon";
import { replaceServerSettings, serverSettings } from "../../pages/settings/settingsState";
import type { UsageResult } from "../../pages/utility-data";
import { requestBackend } from "../../store";
import { ChartColumn, ShareBar } from "./UsageOverview";
import {
  chartSeries, costTypeSegments, formatPercent, formatTokens, formatUsd, modelTotals, providerPresentation, sumTotals, tokenTypeSegments,
  type PeriodTotals,
} from "./usageFormat";
import {
  cacheHitRate, costPerMillionTokens, isEmptyUsagePriceDraft, isUsagePriceEdit, priceRowsFrom, USAGE_PRICE_FIELDS, usageAliasCell, usagePriceCell, usagePriceTableChanges, usagePriceTableErrors, writeUsagePrices,
  type PriceRow, type UsagePrice, type UsagePriceDraft, type UsagePriceKey, type UsagePriceTarget, type UsagePriceWriteResult,
} from "./usageSelection";
import { loadUsagePriceTargets, writeUsagePriceSettings } from "./usagePriceTargets";
import { createAnchor, Popup } from "../composer/Popover";
import { openUsageDialog, usageDialog, usageEnvironmentList, usageEnvironmentSelection } from "./usageState";
import { dialogBackdropStyle } from "../dialogSurface";

function Backdrop(props: { children: unknown; onClose: () => void }) {
  return (
    <View class="absolute inset-0 items-center justify-center p-6" style={dialogBackdropStyle()} onPress={props.onClose}>
      {props.children as never}
    </View>
  );
}

function DialogButton(props: { label: string; primary?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      onPress={() => { if (!props.disabled) props.onPress(); }}
      class={props.primary
        ? (props.disabled ? "h-8 items-center justify-center rounded-lg bg-primary px-3 opacity-50 active:scale-[0.97] transition-transform duration-150 ease-in-out" : "h-8 items-center justify-center rounded-lg bg-primary px-3 active:scale-[0.97] transition-transform duration-150 ease-in-out")
        : (props.disabled ? "h-8 items-center justify-center rounded-lg px-3 opacity-50" : "h-8 items-center justify-center rounded-lg px-3 hover:bg-accent")}
    >
      <Text class={props.primary ? "text-sm font-medium text-primary-foreground" : "text-sm text-foreground"}>{props.label}</Text>
    </View>
  );
}

export function UsageModelDialog(props: {
  result: () => UsageResult;
  metric: () => "cost" | "tokens";
  window: () => { sinceDay: string; untilDay: string; hourly: boolean };
}) {
  const target = () => { const d = usageDialog(); return d?.kind === "model" ? d : null; };
  const buckets = () => props.result().buckets.filter((bucket) => bucket.provider === target()?.provider && bucket.model === target()?.model);
  const model = () => modelTotals(buckets(), props.metric())[0];
  const unpriced = () => { const m = model(); return !!m && m.costUsd === 0 && m.total > 0; };
  const series = () => chartSeries(buckets(), props.window().sinceDay, props.window().untilDay, props.window().hourly);
  const metric = () => (unpriced() ? "tokens" : props.metric());
  const peak = () => series().reduce((max, period) => Math.max(max, metric() === "cost" ? period.costUsd : period.total), 0);
  const close = () => openUsageDialog(null);
  useOverlayOpen(() => !!target() && !!model(), "usage model dialog");
  effect(() => { if (!target()) return; return keymap.bind({ escape: close }); });
  const stats = () => {
    const m = model();
    if (!m) return [];
    const perMillion = costPerMillionTokens(m);
    const hit = cacheHitRate(m);
    return [
      { label: "Cost", value: unpriced() ? "Unpriced" : formatUsd(m.costUsd) },
      { label: "Tokens", value: formatTokens(m.total) },
      ...(perMillion === null ? [] : [{ label: "Per 1M tokens", value: formatUsd(perMillion) }]),
      ...(hit === null ? [] : [{ label: "Cache hit", value: formatPercent(hit) }]),
    ];
  };
  return <>{target() && model() ? (
    <Backdrop onClose={close}>
      <View onPress={() => undefined} accessibilityLabel="Model usage" class="max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-background">
        <View class="flex-row items-start gap-2 px-6 pb-3 pt-6">
          <View class="min-w-0 flex-1 flex-col gap-1">
            <View class="flex-row items-center gap-2">
              <ProviderMark provider={target()!.provider} size={20} />
              <Text class="truncate text-xl font-semibold text-foreground">{target()!.model}</Text>
            </View>
            <Text class="text-sm text-muted-foreground">{`${providerPresentation(target()!.provider).label}${unpriced() ? "" : ` · ${formatPercent(model()!.costShare)} of cost`}`}</Text>
          </View>
          <View accessibilityLabel="Close" onPress={close} class="size-7 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"><Icon name="x" size={16} /></View>
        </View>
        <FadeScroll class="min-h-0 shrink" contentClass="px-6 pb-6">
          <View class="flex-col gap-8">
            <View class="flex-row flex-wrap gap-x-6 gap-y-4">
              <Each of={stats()} key={(stat: { label: string; value: string }) => stat.label}>
                {(stat) => (
                  <View class="min-w-32 flex-1 flex-col gap-0.5">
                    <Text class="text-xs text-muted-foreground">{stat().label}</Text>
                    <Text class="text-2xl font-semibold text-foreground">{stat().value}</Text>
                  </View>
                )}
              </Each>
            </View>
            <View class="flex-col gap-3">
              <Text class="text-sm font-medium text-foreground">{`${props.window().hourly ? "Hourly" : "Daily"} ${metric() === "tokens" ? "processed tokens" : "cost"}`}</Text>
              <View class="flex-row items-end gap-0.5">
                <Each of={series()} key={(period: PeriodTotals) => period.key}>
                  {(period) => <ChartColumn period={period()} metric={metric} peak={peak} />}
                </Each>
              </View>
            </View>
            <View class="flex-row gap-10">
              {unpriced() ? null : <ShareBar label="Cost by type" segments={() => costTypeSegments(buckets())} format={formatUsd} />}
              <ShareBar label="Tokens by type" segments={() => tokenTypeSegments(sumTotals(buckets()))} format={formatTokens} />
            </View>
          </View>
        </FadeScroll>
        {unpriced() ? (
          <View class="flex-row items-center justify-between gap-3 px-6 pb-6">
            <Text class="text-xs text-muted-foreground">{`${formatTokens(model()!.total)} tokens have no known price`}</Text>
            <DialogButton label="Set price" primary onPress={() => openUsageDialog({ kind: "prices", model: target()!.model })} />
          </View>
        ) : null}
      </View>
    </Backdrop>
  ) : null}</>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The server's custom prices and mappings as editable rows. */
export function serverPriceRows(): PriceRow[] {
  const settings = asRecord(serverSettings());
  const prices = asRecord(settings.usagePriceOverrides) as Record<string, UsagePrice>;
  const aliases = asRecord(settings.usageModelAliases) as Record<string, string>;
  return priceRowsFrom(prices, Object.fromEntries(Object.entries(aliases).filter(([, value]) => typeof value === "string")));
}

interface PriceField { key: UsagePriceKey; label: string; optional: boolean }

type Attempt = { drafts: UsagePriceDraft[]; destinations: { id: string; label: string }[]; results: Record<string, UsagePriceWriteResult | { status: "saving" }> };

/** One checkable environment in "Apply to", with why it cannot be changed. */
function ApplyToItem(props: { label: string; checked: boolean; note?: string | null; onPress: () => void }) {
  return (
    <View role="button" accessibilityLabel={props.label} accessibilityState={{ checked: props.checked }} onPress={props.onPress} class="h-8 flex-row items-center gap-2 rounded-sm px-2 hover:bg-accent-50">
      <View class="size-4 items-center justify-center">{props.checked ? <UsageIcon name="check" size={14} /> : null}</View>
      <Text class="min-w-0 flex-1 truncate text-sm text-foreground">{props.label}</Text>
      {props.note ? <Text class="text-xs text-muted-foreground">{props.note}</Text> : null}
    </View>
  );
}

export function UsagePriceDialog() {
  const target = () => { const d = usageDialog(); return d?.kind === "prices" ? d : null; };
  const targets = signal<UsagePriceTarget[]>([]);
  const loading = signal(false);
  /** The environments the edits apply to; null is all of them. */
  const selectedIds = signal<Set<string> | null>(null);
  const drafts = signal<UsagePriceDraft[]>([]);
  const pending = signal(false);
  const attempt = signal<Attempt | null>(null);
  const menuOpen = signal(false);
  const anchor = createAnchor();
  let nextRow = 1;
  let sequence = 0;

  let opened: unknown = null;
  effect(() => {
    const open = target();
    if (!open) { sequence++; opened = null; return; }
    // The editor starts once per opening; a later re-run for the same opening must not reset what is being edited.
    if (opened === open) return;
    opened = open;
    const mine = ++sequence;
    const environments = untracked(() => usageEnvironmentList());
    const chosen = untracked(() => usageEnvironmentSelection());
    selectedIds.set(chosen === null ? null : new Set(chosen));
    drafts.set([]); attempt.set(null); pending.set(false); menuOpen.set(false); targets.set([]);
    loading.set(true);
    void loadUsagePriceTargets(environments).then((loaded) => {
      if (mine !== sequence) return;
      targets.set(loaded);
      loading.set(false);
      const inSelection = loaded.filter((entry) => chosen === null || chosen.has(entry.id));
      // A model to price starts as a new row, unless an environment already has a row for it.
      if (open.model !== undefined && !inSelection.some((entry) => Object.hasOwn(entry.prices ?? {}, open.model as string) || Object.hasOwn(entry.aliases ?? {}, open.model as string)))
        drafts.set([{ id: `new:${nextRow++}`, model: open.model, isNew: true, values: {} }]);
    });
  });

  const selected = () => targets().filter((entry) => selectedIds() === null || selectedIds()!.has(entry.id));
  const customModels = () => [...new Set(selected().flatMap((entry) => [...Object.keys(entry.prices ?? {}), ...Object.keys(entry.aliases ?? {})]))].sort();
  const newModels = () => new Set(drafts().filter((draft) => draft.isNew).map((draft) => draft.model.trim()));
  const rows = (): UsagePriceDraft[] => [
    ...customModels().filter((model) => attempt() === null || !newModels().has(model)).map((model) => drafts().find((draft) => draft.id === `model:${model}`) ?? { id: `model:${model}`, model, isNew: false, values: {} }),
    ...drafts().filter((draft) => draft.isNew),
  ];
  const staged = () => drafts().filter((draft) => !isEmptyUsagePriceDraft(draft));
  const errors = () => {
    const found = usagePriceTableErrors(selected(), staged());
    for (const draft of staged()) {
      if (!draft.isNew) continue;
      if (draft.model.trim() === "") found.set(draft.id, "Enter a model ID.");
      else if (attempt() === null && (customModels().includes(draft.model.trim()) || drafts().some((other) => other.id !== draft.id && other.model.trim() === draft.model.trim()))) found.set(draft.id, "This model already has a row. Edit its prices there.");
    }
    return found;
  };
  const failedDestinations = () => attempt()?.destinations.filter((destination) => attempt()!.results[destination.id]?.status === "failed") ?? [];
  const locked = () => pending() || failedDestinations().length > 0;
  const hasChanges = () => staged().length > 0;
  const destinationLabel = () => (selected().length === 1 ? selected()[0]!.label : `${selected().length} environments`);
  const selectionLabel = () => (selectedIds() === null ? "All environments" : destinationLabel());
  const close = () => { if (!pending()) openUsageDialog(null); };
  useOverlayOpen(() => target() !== null, "usage price dialog");
  effect(() => { if (!target()) return; return keymap.bind({ escape: () => { if (menuOpen()) menuOpen.set(false); else close(); } }); });

  const discard = () => { drafts.set([]); attempt.set(null); };
  const selectEnvironments = (ids: Set<string> | null) => { selectedIds.set(ids); attempt.set(null); };
  const updateDraft = (draft: UsagePriceDraft) => { drafts.update((all) => (all.some((entry) => entry.id === draft.id) ? all.map((entry) => (entry.id === draft.id ? draft : entry)) : [...all, draft])); attempt.set(null); };
  /** An edit back to the shown value is no edit (matchesSaved). */
  const matchesSaved = (row: UsagePriceDraft, cell: { value: string; placeholder: string }, value: string) => !row.isNew && cell.placeholder !== "Mixed" && cell.placeholder !== "Unavailable" && value === cell.value;
  const updateOrDrop = (draft: UsagePriceDraft) => {
    if (!draft.isNew && Object.keys(draft.values).length === 0 && draft.alias === undefined && !draft.removed) drafts.update((all) => all.filter((entry) => entry.id !== draft.id));
    else updateDraft(draft);
  };
  const editCell = (row: UsagePriceDraft, field: UsagePriceKey, value: string) => {
    const values = { ...row.values, [field]: value };
    if (matchesSaved(row, usagePriceCell(selected(), row.model, field), value)) delete values[field];
    updateOrDrop({ ...row, values });
  };
  const editAlias = (row: UsagePriceDraft, value: string) => {
    const { alias: _alias, ...rest } = row;
    updateOrDrop(matchesSaved(row, usageAliasCell(selected(), row.model), value) ? rest : { ...rest, alias: value });
  };

  async function save(retry = false) {
    if (pending()) return;
    const destinations = retry ? failedDestinations() : selected().map((entry) => ({ id: entry.id, label: entry.label }));
    const edits = retry && attempt() ? attempt()!.drafts : staged();
    if (destinations.length === 0 || edits.length === 0) return;
    const writing = destinations.map((destination) => targets().find((entry) => entry.id === destination.id) ?? { ...destination, prices: null, aliases: null, unavailable: "Environment removed" });
    const planned = new Map(writing.map((entry) => [entry.id, usagePriceTableChanges(entry, edits)] as const));
    pending.set(true);
    const previous = attempt();
    attempt.set({ drafts: edits, destinations: retry && previous ? previous.destinations : writing.map((entry) => ({ id: entry.id, label: entry.label })), results: { ...(retry && previous ? previous.results : {}), ...Object.fromEntries(writing.map((entry) => [entry.id, { status: "saving" as const }])) } });
    let failed = false;
    await writeUsagePrices({
      targets: writing.map((entry) => ({ ...entry, unavailable: entry.unavailable ?? [...planned.get(entry.id)!.errors.values()][0] ?? null })),
      changes: new Map([...planned].map(([id, plan]) => [id, plan.changes] as const)),
      write: writeUsagePriceSettings,
      onResult: (id, result) => { if (result.status === "failed") failed = true; attempt.update((all) => (all === null ? null : { ...all, results: { ...all.results, [id]: result } })); },
    });
    pending.set(false);
    if (!failed) {
      drafts.set([]);
      // What was saved is what the environments hold now.
      void loadUsagePriceTargets(usageEnvironmentList()).then((loaded) => { if (target()) targets.set(loaded); });
    }
  }

  return <>{target() ? (
    <Backdrop onClose={close}>
      <View onPress={() => undefined} accessibilityLabel="Custom model prices" class="max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-popover">
        <View class="flex-row items-start gap-2 px-6 pb-3 pt-6">
          <View class="min-w-0 flex-1 flex-col gap-1">
            <Text class="text-xl font-semibold text-foreground">Custom model prices</Text>
            <Text class="text-sm text-muted-foreground">Prices and mappings apply to all past and future usage on the environments you select.</Text>
          </View>
          <View accessibilityLabel="Close" onPress={close} class="size-7 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"><Icon name="x" size={16} /></View>
        </View>
        <FadeScroll surface="popover" class="min-h-0 shrink" contentClass="px-6 pb-4">
          <View class="flex-col gap-3">
            <View class="flex-row flex-wrap items-center justify-between gap-2">
              <View class="min-w-0 flex-row items-center gap-2">
                <Text class="shrink-0 text-sm font-medium text-foreground">Apply to</Text>
                <View ref={anchor.ref} role="button" accessibilityLabel={`Apply to ${selectionLabel()}`} accessibilityState={{ disabled: pending() || hasChanges() }}
                  onPress={() => { if (!pending() && !hasChanges()) menuOpen.update((open) => !open); }}
                  class={`h-8 min-w-0 flex-row items-center gap-1.5 rounded-lg border border-border px-3 ${pending() || hasChanges() ? "opacity-50" : "hover:bg-accent-50"}`}>
                  <Text class="min-w-0 truncate text-sm text-foreground">{selectionLabel()}</Text>
                  <UsageIcon name="chevron-down" size={14} />
                </View>
                {menuOpen() ? <Popup anchor={anchor.anchor} onClose={() => menuOpen.set(false)} placement="bottom" align="start" class="min-w-56">
                  <View class="flex-col p-1">
                    <ApplyToItem label="All environments" checked={selectedIds() === null} onPress={() => selectEnvironments(selectedIds() === null ? new Set() : null)} />
                    <View class="mx-2 my-1 h-px bg-border" />
                    <Each of={targets()} key={(entry) => entry.id}>{(entry) => <ApplyToItem label={entry().label} checked={selectedIds() === null || selectedIds()!.has(entry().id)} note={entry().unavailable}
                      onPress={() => {
                        const next = new Set(selected().map((item) => item.id));
                        if (next.has(entry().id)) next.delete(entry().id); else next.add(entry().id);
                        selectEnvironments(next.size === targets().length ? null : next);
                      }} />}</Each>
                  </View>
                </Popup> : null}
              </View>
              <Text class="text-xs text-muted-foreground">USD / million tokens</Text>
            </View>
            {selected().length === 0 ? (
              <Text class="text-sm text-muted-foreground">{loading() ? "Loading prices..." : targets().length === 0 ? "Connect an environment to set model prices." : "Select an environment to see and change its model prices."}</Text>
            ) : <>
              <View class="flex-col overflow-hidden rounded-lg border border-border">
                <View class="flex-row items-center gap-2 border-b border-border px-3 py-2">
                  <Text class="w-40 text-xs font-medium text-muted-foreground">Model ID</Text>
                  <Text class="w-28 text-xs font-medium text-muted-foreground">Map to</Text>
                  <Each of={[...USAGE_PRICE_FIELDS]} key={(field: PriceField) => field.key}>
                    {(field) => <Text class="min-w-0 flex-1 text-xs font-medium text-muted-foreground">{field().label}</Text>}
                  </Each>
                  <View role="button" accessibilityLabel="Add model price" accessibilityState={{ disabled: locked() }}
                    onPress={() => { if (!locked()) updateDraft({ id: `new:${nextRow++}`, model: "", isNew: true, values: {} }); }}
                    class={locked() ? "size-6 items-center justify-center rounded-md opacity-50" : "size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"}
                  ><UsageIcon name="plus" size={14} /></View>
                </View>
                {rows().length === 0 ? <Text class="px-3 py-6 text-center text-sm text-muted-foreground">{selected().some((entry) => entry.prices === null) ? "Some environment prices are unavailable." : "No custom prices or mappings. Add a row to set one."}</Text> : null}
                {/* Rows are keyed by id and looked up on each read, so typing in a cell never rebuilds its row (and drops its focus). */}
                <Each of={rows().map((entry) => entry.id)} key={(id: string) => id}>
                  {(rowId) => {
                    const row = () => rows().find((entry) => entry.id === rowId()) ?? { id: rowId(), model: "", isNew: true, values: {} };
                    const aliasCell = () => usageAliasCell(selected(), row().model);
                    const alias = () => (row().alias ?? aliasCell().value).trim();
                    // A branch reads one of these, not the row, so editing a cell never rebuilds the inputs (and drops their focus).
                    const isNew = computed(() => row().isNew);
                    const removed = computed(() => row().removed === true);
                    const mapped = computed(() => alias() !== "");
                    return (
                      <View class={row().removed ? "flex-row items-start gap-2 border-b border-border-50 px-3 py-1.5 opacity-50" : "flex-row items-start gap-2 border-b border-border-50 px-3 py-1.5"}>
                        {/* reference uses break-all on the model IDs; NSH has no break-all, Text wraps at word boundaries */}
                        <View class="w-40 flex-col gap-1">
                          {isNew()
                            ? <Input accessibilityLabel="New model ID" placeholder="Model ID" readonly={locked()} value={row().model} onChange={(e) => updateDraft({ ...row(), model: e.value })} class="h-7.5 rounded-md border border-input bg-background px-2 text-sm text-foreground" />
                            : <Text class={`text-sm ${row().removed ? "text-muted-foreground line-through" : "text-foreground"}`}>{row().model}</Text>}
                          {errors().has(row().id) && (row().model.trim() !== "" || Object.values(row().values).some((value) => value !== "")) ? <Text role="alert" class="text-xs text-destructive">{errors().get(row().id)}</Text> : null}
                        </View>
                        {removed() ? <Text class="min-w-0 flex-1 pt-1.5 text-sm text-muted-foreground">Automatic pricing after saving</Text> : <>
                          <View class="w-28">
                            <Input accessibilityLabel={`Map ${row().isNew ? "new model" : row().model} to model`} placeholder={row().isNew ? "Optional" : aliasCell().placeholder} readonly={locked()} value={row().alias ?? aliasCell().value} onChange={(e) => editAlias(row(), e.value)} class="h-7.5 rounded-md border border-input bg-background px-2 text-sm text-foreground" />
                          </View>
                          {mapped() ? <Text class="min-w-0 flex-[4] pt-1.5 text-sm text-muted-foreground">{`Counted as ${alias()}`}</Text> : <Each of={[...USAGE_PRICE_FIELDS]} key={(field: PriceField) => field.key}>
                            {(field) => {
                              const cell = () => usagePriceCell(selected(), row().model, field().key);
                              const value = () => row().values[field().key] ?? (row().isNew ? "" : cell().value);
                              return (
                                <View class="min-w-0 flex-1">
                                  <Input
                                    accessibilityLabel={`${field().label} price for ${row().isNew ? "new model" : row().model}`}
                                    placeholder={row().isNew ? (field().optional ? "Input rate" : "0.00") : cell().placeholder}
                                    readonly={locked()}
                                    value={value()}
                                    onChange={(e) => { if (isUsagePriceEdit(value(), e.value)) editCell(row(), field().key, e.value); }}
                                    class="h-7.5 rounded-md border border-input bg-background px-2 font-mono text-sm text-foreground"
                                  />
                                </View>
                              );
                            }}
                          </Each>}
                        </>}
                        <View
                          role="button"
                          accessibilityLabel={row().removed ? `Undo reset for ${row().model}` : row().isNew ? "Remove new model" : `Reset price for ${row().model} to automatic`}
                          accessibilityState={{ disabled: locked() }}
                          onPress={() => {
                            if (locked()) return;
                            if (row().isNew) drafts.update((all) => all.filter((entry) => entry.id !== row().id));
                            else if (row().removed) updateOrDrop({ ...row(), removed: false });
                            else updateDraft({ ...row(), removed: true });
                          }}
                          tooltip={<Tip label={row().removed ? "Undo reset" : row().isNew ? "Remove row" : "Reset to automatic"} />}
                          class={locked() ? "size-6 items-center justify-center rounded-md opacity-50" : "size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"}
                        ><UsageIcon name={row().isNew ? "x" : "rotate-ccw"} size={14} /></View>
                      </View>
                    );
                  }}
                </Each>
              </View>
              <Text class="text-xs text-muted-foreground">{`Blank cache rates use the input price. Enter 0 for free tokens. A mapped model's usage counts as the model it maps to.${selected().length > 1 ? " Mixed cells keep each environment's rate until you edit them." : ""}`}</Text>
            </>}
            {attempt() ? (
              <View class="flex-col gap-1" accessibilityLabel="Save results">
                <Each of={attempt()!.destinations} key={(destination: { id: string; label: string }) => destination.id}>
                  {(destination) => {
                    const result = () => attempt()?.results[destination().id];
                    return (
                      <View class="flex-row justify-between gap-3">
                        <Text class="min-w-0 truncate text-xs text-muted-foreground">{destination().label}</Text>
                        <Text class={result()?.status === "failed" ? "text-right text-xs text-destructive" : "text-xs text-muted-foreground"}>
                          {result()?.status === "failed" ? `Not saved · ${(result() as { error: string }).error}` : result()?.status === "saved" ? "Saved" : "Saving…"}
                        </Text>
                      </View>
                    );
                  }}
                </Each>
              </View>
            ) : null}
          </View>
        </FadeScroll>
        <View class="flex-row items-center justify-between gap-2 px-6 pb-6">
          <Text class="text-xs text-muted-foreground">{hasChanges() ? `Changes apply to ${destinationLabel()}` : ""}</Text>
          <View class="flex-row items-center gap-2">
            {hasChanges() ? <DialogButton label={failedDestinations().length > 0 ? "Discard pending changes" : "Discard changes"} disabled={pending()} onPress={discard} /> : null}
            <DialogButton
              label={pending() ? "Saving…" : failedDestinations().length > 0 ? "Retry failed saves" : "Save changes"}
              primary
              disabled={pending() || (!hasChanges() && failedDestinations().length === 0) || (failedDestinations().length === 0 && (errors().size > 0 || selected().length === 0))}
              onPress={() => void save(failedDestinations().length > 0)}
            />
          </View>
        </View>
      </View>
    </Backdrop>
  ) : null}</>;
}
