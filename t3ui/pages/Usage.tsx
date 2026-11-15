import { effect, Image, keymap, Scroll, signal, Text, untracked, View, windowSize } from "nsh";
import { registerCommands } from "../commands/registry";
import { EscapeCancel, editorHoldsKeyboard } from "../components/EscapeCancel";
import { Icon } from "../components/Icons";
import refreshIcon from "../components/usage/icons/refresh-cw.svg";
import { UsageLimitsSection } from "../components/usage/UsageLimits";
import { UsageOverview, UsageSkeleton } from "../components/usage/UsageOverview";
import { UsageModelDialog, UsagePriceDialog } from "../components/usage/UsageDialogs";
import { UsageEnvironmentMenu, UsageProviderMenu, closeUsageMenus, usageMenuOpen } from "../components/usage/UsageMenus";
import { filterUsageByProviders, mergeUsageResults, selectedEnvironments } from "../components/usage/usageSelection";
import {
  openUsageDialog, restoreUsagePreferences, usageDialog, usageEnvironmentList, usageEnvironmentSelection, usageHiddenProviders,
} from "../components/usage/usageState";
import { formatDayShort, providerForDriver } from "../components/usage/usageFormat";
import { primaryUsageUrl, readUsageLimitSources, refreshLimitsOnce, requestUsageEnvironment, usageReadFailure } from "../components/usage/usageEnvironments";
import {
  USAGE_STALE_MS, loadUsageSummary, peekUsageLimits, peekUsageSummary, rememberUsageLimits, restoreUsageCacheFromStorage, subscribeUsageSummary,
} from "../components/usage/usageCache";
import { scheduleUsagePrewarm } from "../components/usage/usagePrewarm";
import {
  backendStatus, breakdownTab, closeUsage, openSettings, paletteOpen, rawProviderRecords, sendingThreadIdList, setBreakdownTab,
  setUsageMetric, setUsagePeriod, onServerConfigEvent, threadWorking, usageMetricValue, usageOpen, usagePeriod,
} from "../store";
import { parseUsageLimits, parseUsageLimitSources, usageWindow, type UsageLimitAccount, type UsageLimitSource, type UsageResult } from "./utility-data";
import { dialogBackdropStyle } from "../components/dialogSurface";
import { createAnchor, Popup } from "../components/composer/Popover";
import { UsageIcon } from "../components/usage/UsageIcon";

const WINDOWS = [
  { key: "1", label: "Past 24h" }, { key: "7", label: "7 days" },
  { key: "30", label: "30 days" }, { key: "90", label: "90 days" },
];
const METRICS = [{ key: "cost", label: "Cost" }, { key: "tokens", label: "Tokens" }, { key: "limits", label: "Limits" }];

function Segmented(props: { label: string; options: { key: string; label: string }[]; selected: () => string; onSelect: (key: string) => void }) {
  // The wrapper carries no accessibilityLabel or role of its own: nsh-runtime-bugs.md #7 (an unlabelled, roleless View
  // with pressable descendants, nested under a pressable ancestor with no Scroll between them, works; giving this
  // wrapper any accessibilityLabel or role collapses it into a leaf that drops its role="button" children from both
  // the accessibility tree and pointer hit-testing). Each option still carries its own accessibilityLabel.
  return <View class="flex-row items-center gap-0.5 rounded-lg bg-segmented-track p-0.5"><Each of={props.options} key={(option) => option.key}>{(option) => <View role="button" accessibilityLabel={option().label} onPress={() => props.onSelect(option().key)} class={option().key === props.selected() ? "rounded-md bg-segmented-active px-2.5 py-1 transition-colors duration-150 ease-in-out" : "rounded-md px-2.5 py-1 hover:bg-segmented-hover transition-colors duration-150 ease-in-out"}><Text class={option().key === props.selected() ? "text-xs font-medium text-foreground" : "text-xs text-muted-foreground"}>{option().label}</Text></View>}</Each></View>;
}

/** The reference replaces the segmented controls with compact select menus in narrower headers. */
function CompactSelect(props: { label: string; options: { key: string; label: string }[]; selected: () => string; open: () => boolean; setOpen: (open: boolean) => void; onSelect: (key: string) => void }) {
  const anchor = createAnchor();
  return <View>
    <View ref={anchor.ref} role="button" accessibilityLabel={props.label} onPress={() => props.setOpen(!props.open())} class="h-7 flex-row items-center gap-1 rounded-md px-1.5 hover:bg-accent">
      <Text class="text-xs text-foreground">{props.options.find((option) => option.key === props.selected())?.label ?? ""}</Text>
      <UsageIcon name="chevron-down" size={14} />
    </View>
    {props.open() ? <Popup anchor={anchor.anchor} onClose={() => props.setOpen(false)} placement="bottom" align="end" class="min-w-32">
      <View class="p-1">
        <Each of={props.options} key={(option) => option.key}>{(option) => <View role="button" accessibilityLabel={`Select ${option().label}`} accessibilityState={{ selected: option().key === props.selected() }} onPress={() => { props.onSelect(option().key); props.setOpen(false); }} class="h-7 flex-row items-center gap-2 rounded-sm px-2 hover:bg-accent">
          <View class="size-4 items-center justify-center">{option().key === props.selected() ? <UsageIcon name="check" size={14} /> : null}</View><Text class="text-sm text-popover-foreground">{option().label}</Text>
        </View>}</Each>
      </View>
    </Popup> : null}
  </View>;
}

export function Usage() {
  const showingLimits = () => usageMetricValue() === "limits";
  const headerWidth = signal(Math.max(0, windowSize().width - 80));
  const compactMenu = signal<"period" | "metric" | null>(null);
  const wideHeader = () => headerWidth() >= 896;
  effect(() => { if (!usageOpen()) compactMenu.set(null); });
  restoreUsagePreferences();
  // Last session's answers (validated on read), so opening Usage right after launch can paint instantly.
  void restoreUsageCacheFromStorage();
  // A few seconds after connecting, while idle, warm the cache for the environments this page will read:
  // by the time the user opens it, the server's cold scan has already happened. Once per session.
  scheduleUsagePrewarm({
    isConnected: () => backendStatus() === "connected",
    isIdle: () => sendingThreadIdList().length === 0 && !threadWorking(),
    environments: () => usageEnvironmentList(),
    defaultPeriodDays: () => usagePeriod(),
  });
  // One answer per environment id; the page shows their sum for the selection.
  const results = signal<Record<string, UsageResult>>({});
  const limitsByEnvironment = signal<Record<string, UsageLimitAccount[]>>({});
  const selected = () => selectedEnvironments(usageEnvironmentList(), usageEnvironmentSelection());
  const result = (): UsageResult | null => {
    const answered = selected().flatMap((env) => (results()[env.id] ? [results()[env.id]!] : []));
    return answered.length > 0 ? filterUsageByProviders(mergeUsageResults(answered), usageHiddenProviders()) : null;
  };
  // The live connection's own provider list already carries each account's limits (the config stream), so the bars
  // show at once; refreshing probes the providers again in the background and never gates the page.
  const liveAccounts = (): UsageLimitAccount[] => parseUsageLimits({ providers: rawProviderRecords() }, true);
  // The usage limit sources (hubs such as CLIProxy) are a stream-only, opt-in part of the config stream: the live connection
  // is subscribed with `usageLimitSources` while the page is open, and the server sends the current set at once.
  const hubSources = signal<UsageLimitSource[]>([]);
  effect(() => {
    if (!usageOpen() || backendStatus() !== "connected") { hubSources.set([]); return; }
    let stopped = false;
    // The store's one config stream carries usageLimitSources (rpc/session.ts shares one stream per environment).
    const stop = onServerConfigEvent((value) => {
      if (stopped || typeof value !== "object" || value === null) return;
      const event = value as { type?: unknown; config?: { usageLimitSources?: unknown }; payload?: { sources?: unknown } };
      if (event.type === "snapshot" && event.config && "usageLimitSources" in event.config) hubSources.set(parseUsageLimitSources(event.config.usageLimitSources));
      else if (event.type === "usageLimitSourcesUpdated") hubSources.set(parseUsageLimitSources(event.payload?.sources));
    });
    return () => { stopped = true; stop(); };
  });
  // A saved environment's sources are read with its limits: it has no live stream here, so each refresh asks it once.
  const hubByEnvironment = signal<Record<string, UsageLimitSource[]>>({});
  const accountsOf = (id: string): UsageLimitAccount[] => {
    const answered = limitsByEnvironment()[id] ?? [];
    if (id !== primaryUsageUrl()) return [...answered, ...(hubByEnvironment()[id] ?? []).flatMap((source) => source.accounts)];
    const live = liveAccounts();
    const hub = hubSources().flatMap((source) => source.accounts);
    return [...live, ...answered.filter((account) => !live.some((entry) => entry.id === account.id)), ...hub];
  };
  const limitSources = () => selected().flatMap((env) => (env.id === primaryUsageUrl() ? hubSources() : hubByEnvironment()[env.id] ?? []).map((source) => ({ id: source.id, label: source.label, error: source.error, accountCount: source.accounts.length, environmentLabel: env.label })));
  const limits = (): UsageLimitAccount[] => selected()
    .flatMap((env) => accountsOf(env.id).map((account) => ({ ...account, environmentId: env.id, environmentLabel: env.label })))
    .filter((account) => {
      const provider = providerForDriver(account.driver);
      return !provider || !usageHiddenProviders().includes(provider.key);
    });
  // Environments with a read in flight: a slow one never holds back the others.
  const pending = signal<string[]>([]);
  const state = signal<"idle" | "loading" | "loaded" | "error">("idle");
  const error = signal("");
  const limitsNow = signal(Date.now());
  // The window the shown result was read for, so the chart axis matches its data.
  const shownWindow = signal(usageWindow(usagePeriod()));
  let sequence = 0;

  // Environments whose last read failed, with the reason; the rest of the selection still adds up.
  const failures = signal<Record<string, string>>({});

  async function refresh(force = false) {
    const request = ++sequence;
    if (backendStatus() !== "connected") { state.set("idle"); results.set({}); limitsByEnvironment.set({}); failures.set({}); pending.set([]); return; }
    const targets = selected().filter((env) => env.connected);
    const window = usageWindow(usagePeriod());
    const limitsMode = showingLimits();
    error.set("");
    failures.set({});
    pending.set(targets.map((env) => env.id));
    // A different window starts clean so answers for two windows never add up; the same window keeps what it shows until fresher answers land.
    if (!limitsMode && (shownWindow().sinceDay !== window.sinceDay || shownWindow().untilDay !== window.untilDay || shownWindow().resolution !== window.resolution)) results.set({});
    state.set(limitsMode ? "loaded" : "loading");
    if (limitsMode) limitsNow.set(Date.now());
    let failed = 0;
    // Every environment is read on its own: each answer or failure is applied the moment it arrives.
    await Promise.all(targets.map(async ({ id }) => {
      try {
        if (limitsMode) {
          // Last known accounts (this session's cache, or last launch's persisted one) paint before the refresh answers.
          const lastKnown = peekUsageLimits(id);
          if (lastKnown && request === sequence) limitsByEnvironment.update((all) => ({ ...all, [id]: lastKnown.value }));
          const accounts = await refreshLimitsOnce(id, async () => {
            const raw = await requestUsageEnvironment(id, "server.refreshProviders", {}, { timeoutMs: 60000 });
            const parsed = parseUsageLimits(raw);
            rememberUsageLimits(id, raw, parsed);
            return parsed;
          }, !force);
          if (request !== sequence) return;
          if (accounts) limitsByEnvironment.update((all) => ({ ...all, [id]: accounts }));
          if (id !== primaryUsageUrl()) {
            try { const sources = parseUsageLimitSources(await readUsageLimitSources(id)); if (request === sequence) hubByEnvironment.update((all) => ({ ...all, [id]: sources })); } catch { /* the environment's own limits still show */ }
          }
        } else {
          // usageCache.ts: a cached answer paints at once (synchronously, via peek); loadUsageSummary shares one
          // in-flight request with any prewarm or period switch already asking for the same environment and window,
          // and notifies this subscription as each answer (including a still-`refreshing` one, then its awaitRefresh
          // follow-up) arrives, so Cost/Tokens never refetch and a stale or persisted answer updates in place.
          const show = (value: UsageResult) => { results.update((all) => ({ ...all, [id]: value })); shownWindow.set(window); };
          // client-runtime state/usage.ts refreshUsage: an explicit refresh first asks the environment to refresh its
          // usage rates (price tables); a session that cannot answer RPCs skips the summary read, any other failure does not.
          if (force) {
            try { await requestUsageEnvironment(id, "server.refreshUsageRates", {}); }
            catch (cause) { if (cause instanceof Error && /Connect an environment first|unavailable/i.test(cause.message)) return; }
            if (request !== sequence) return;
          }
          const cached = peekUsageSummary(id, window);
          if (cached && !force) {
            show(cached.value);
            if (Date.now() - cached.at < USAGE_STALE_MS && !cached.value.refreshing) return;
          }
          const unsubscribe = subscribeUsageSummary(id, window, (entry) => { if (request === sequence) show(entry.value); });
          try {
            await loadUsageSummary(id, window, { force });
          } finally {
            unsubscribe();
          }
        }
        failures.update((all) => { const { [id]: _ok, ...rest } = all; return rest; });
      } catch (cause) {
        if (request !== sequence) return;
        failed++;
        // A failed environment drops its old answer so the sum never mixes stale and fresh numbers.
        if (!limitsMode) results.update((all) => { const { [id]: _gone, ...rest } = all; return rest; });
        failures.update((all) => ({ ...all, [id]: usageReadFailure(cause) }));
      } finally {
        if (request === sequence) pending.update((ids) => ids.filter((entry) => entry !== id));
      }
    }));
    if (request !== sequence) return;
    if (limitsMode) limitsNow.set(Date.now());
    if (!limitsMode && failed > 0 && failed === targets.length) {
      error.set(Object.values(failures())[0]!);
      state.set("error");
      return;
    }
    state.set("loaded");
  }

  effect(() => {
    const shouldLoad = usageOpen() && backendStatus() === "connected";
    // Limits and usage are different payloads; switching tab always reloads.
    if (usageMetricValue() !== "limits") usagePeriod();
    // Adding, switching off or reselecting an environment reads the new selection.
    selected().map((env) => `${env.id}:${env.connected}`).join(",");
    if (shouldLoad) untracked(() => { void refresh(); });
    else { sequence++; state.set("idle"); results.set({}); limitsByEnvironment.set({}); pending.set([]); }
    return () => { sequence++; };
  });

  // usageShortcuts.ts: c / t / l pick the metric, mod+shift+1..4 the period (not on Limits).
  effect(() => {
    if (!usageOpen()) return;
    const guarded = (run: () => void) => () => { if (!paletteOpen()) run(); };
    const unbind = registerCommands({
      "usage.cost": guarded(() => setUsageMetric("cost")),
      "usage.tokens": guarded(() => setUsageMetric("tokens")),
      "usage.limits": guarded(() => setUsageMetric("limits")),
      "usage.period.day": guarded(() => { if (!showingLimits()) setUsagePeriod(1); }),
      "usage.period.week": guarded(() => { if (!showingLimits()) setUsagePeriod(7); }),
      "usage.period.month": guarded(() => { if (!showingLimits()) setUsagePeriod(30); }),
      "usage.period.quarter": guarded(() => { if (!showingLimits()) setUsagePeriod(90); }),
    });
    return () => unbind();
  });

  // AppRouteModal: Esc closes the page. A dialog or menu inside it takes the key first (its own newer binding / popup).
  effect(() => {
    if (!usageOpen()) return;
    return keymap.bind({ escape: () => { if (usageDialog() !== null) openUsageDialog(null); else if (compactMenu() !== null) compactMenu.set(null); else if (usageMenuOpen() !== null) closeUsageMenus(); else if (!paletteOpen()) closeUsage(); } });
  });

  // ChatGPT shared usage row: some selected environment signs a provider in through a ChatGPT subscription.
  const showChatGptSharing = () => !usageHiddenProviders().includes("codex") && rawProviderRecords().some((provider) => {
    const auth = provider.auth as { status?: unknown; subscriptionSharing?: unknown } | undefined;
    return auth?.status === "authenticated" && auth?.subscriptionSharing === true;
  });

  const phase = (id: string) => {
    const env = usageEnvironmentList().find((entry) => entry.id === id);
    if (!env?.connected) return "Connecting…";
    if (failures()[id] || state() === "error") return "Unavailable";
    if (pending().includes(id)) return "Scanning…";
    return "Ready";
  };
  const noneSelected = () => backendStatus() === "connected" && selected().length === 0;
  const loading = () => backendStatus() === "connected" && (showingLimits() ? pending().length > 0 : state() === "loading");
  const metric = (): "cost" | "tokens" => (usageMetricValue() === "tokens" ? "tokens" : "cost");
  const windowInfo = () => ({ sinceDay: shownWindow().sinceDay, untilDay: shownWindow().untilDay, hourly: shownWindow().resolution === "hour" });
  const windowLabel = () => (shownWindow().resolution === "hour" ? "" : `${formatDayShort(shownWindow().sinceDay)} to ${formatDayShort(shownWindow().untilDay)}`);

  return <View onPress={closeUsage} style={usageOpen() ? dialogBackdropStyle() : undefined} class={usageOpen() ? "absolute inset-0 items-center justify-center p-10" : "hidden"}>
    {/* A prompt editor holding the keyboard outranks the keymap Escape above: take it as an overlay (EscapeCancel.tsx). */}
    {usageOpen() && editorHoldsKeyboard() ? <EscapeCancel onCancel={() => { if (usageDialog() !== null) openUsageDialog(null); else if (compactMenu() !== null) compactMenu.set(null); else if (usageMenuOpen() !== null) closeUsageMenus(); else if (!paletteOpen()) closeUsage(); }} /> : null}
    <View onPress={() => undefined} class="size-full max-h-[960px] max-w-[1280px] flex-col overflow-hidden rounded-2xl border border-border bg-background">
      {/* UsagePage.tsx's <header> is `gap-1` between its topbarContent block and AppRouteModalClose; the
          block's own row (`grid ... @4xl/usage-header:flex`) is `gap-x-3`. Nest the close button outside
          the `gap-3` content row so it keeps the header's 4px gap instead of the row's 12px one. */}
      <View class="min-h-12 shrink-0 flex-row items-center gap-1 border-b border-border py-2 pl-5 pr-2" onLayout={(event) => headerWidth.set(event.bounds.size.width)}>
        <View class="min-w-0 flex-1 flex-row items-center gap-3">
          <View role="navigation" accessibilityLabel="Usage breadcrumb" class="min-w-0 flex-1 flex-row items-center gap-3"><Text class="text-sm font-medium text-muted-foreground">Usage</Text><Text class="text-sm text-icon-muted">/</Text><UsageEnvironmentMenu partial={() => state() === "loading"} failures={() => failures()} showStatus={() => !showingLimits()} hasIssue={() => state() === "error" || Object.keys(failures()).length > 0} phase={phase} /><Text class="text-sm text-icon-muted">/</Text><UsageProviderMenu /></View>
          {showingLimits() || headerWidth() < 1280 ? null : <Text class="min-w-0 truncate text-xs text-muted-foreground">{windowLabel()}</Text>}
          <View class="ml-auto shrink-0 flex-row items-center gap-2">
            {showingLimits() ? null : wideHeader() ? <Segmented label="Usage period" options={WINDOWS} selected={() => String(usagePeriod())} onSelect={(key) => setUsagePeriod(Number(key))} /> : <CompactSelect label="Usage period" options={WINDOWS} selected={() => String(usagePeriod())} open={() => compactMenu() === "period"} setOpen={(open) => compactMenu.set(open ? "period" : null)} onSelect={(key) => setUsagePeriod(Number(key))} />}
            {wideHeader() ? <Segmented label="Usage metric" options={METRICS} selected={() => usageMetricValue()} onSelect={(key) => { if (key === "cost" || key === "tokens" || key === "limits") setUsageMetric(key); }} /> : <CompactSelect label="Usage metric" options={METRICS} selected={() => usageMetricValue()} open={() => compactMenu() === "metric"} setOpen={(open) => compactMenu.set(open ? "metric" : null)} onSelect={(key) => { if (key === "cost" || key === "tokens" || key === "limits") setUsageMetric(key); }} />}
            <View accessibilityLabel={showingLimits() ? "Refresh limits" : "Refresh usage"} onPress={() => { if (!loading()) void refresh(true); }} class={loading() ? "size-7 items-center justify-center rounded-md opacity-50" : "size-7 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"}><Image src={refreshIcon} style={{ width: 14, height: 14 }} /></View>
          </View>
        </View>
        <View accessibilityLabel="Close" class="size-7 shrink-0 items-center justify-center rounded-md active:bg-accent" onPress={closeUsage}><Icon name="x" size={16} /></View>
      </View>
      <Scroll class="flex-1" contentClass="px-6 pb-12 pt-6">
        <View class="mx-auto w-full max-w-5xl flex-col gap-6">
          {backendStatus() !== "connected" ? <View class="items-start gap-3"><Text class="text-sm text-muted-foreground">{`Connect an environment to see ${showingLimits() ? "limits" : "usage"}.`}</Text><View accessibilityLabel="Open environment settings" onPress={() => openSettings("/settings/connections")} class="rounded-md border border-border px-3 py-1.5 hover:bg-accent"><Text class="text-xs text-foreground">Open settings</Text></View></View> : null}
          {noneSelected() ? <Text class="text-sm text-muted-foreground">{`Select an environment to see ${showingLimits() ? "limits" : "usage"}.`}</Text> : null}
          {backendStatus() === "connected" && showingLimits() && !noneSelected() && pending().length > 0 && limits().length === 0 ? <Text class="text-sm text-muted-foreground">Loading limits...</Text> : null}
          {loading() && !showingLimits() && !result() ? <UsageSkeleton message="Loading usage... The first scan can take a few minutes." /> : null}
          {backendStatus() === "connected" && showingLimits() && !noneSelected() && (limits().length > 0 || pending().length === 0) ? <UsageLimitsSection accounts={() => limits()} sources={limitSources} now={() => limitsNow()} /> : null}
          {showingLimits() ? <Each of={Object.entries(failures())} key={(entry: [string, string]) => entry[0]}>{(entry) => <Text class="text-xs text-destructive">{`${usageEnvironmentList().find((env) => env.id === entry()[0])?.label ?? entry()[0]}: ${entry()[1]}`}</Text>}</Each> : null}
          {state() === "error" ? <View class="items-center py-12"><Text class="text-center text-sm text-destructive">{error()}</Text></View> : null}
          {backendStatus() === "connected" && !showingLimits() && (state() === "loaded" || state() === "loading") && !noneSelected() && result() ? <View class={`transition-opacity duration-150 ease-in-out ${loading() ? "opacity-40 delay-150" : ""}`}><UsageOverview showChatGptSharing={showChatGptSharing} result={() => result() as UsageResult} metric={metric} window={windowInfo} breakdown={() => breakdownTab()} onBreakdown={setBreakdownTab} onModel={(provider, model) => openUsageDialog({ kind: "model", provider, model })} /></View> : null}
        </View>
      </Scroll>
    </View>
    {result() ? <UsageModelDialog result={() => result() as UsageResult} metric={metric} window={windowInfo} /> : null}
    <UsagePriceDialog />
  </View>;
}
