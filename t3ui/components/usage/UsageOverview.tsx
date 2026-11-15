// Cost and Tokens tabs, ported from UsagePage.tsx's UsageOverview: the headline figure,
// provider shares, the daily/hourly chart, Totals, share bars and the Breakdown table.
import { Image, openUrl, signal, Text, View } from "nsh";
import { createAnchor, hoverOpen, Popup } from "../composer/Popover";
import { UsageIcon } from "./UsageIcon";
import { CHATGPT_USAGE_URL } from "./usageResetCredits";
import type { UsageResult } from "../../pages/utility-data";
import {
  chartSeries, costTypeSegments, speedCostOf, speedCostSegments, formatCount, formatDayShort, formatPercent, formatTokens, formatUsd, modelTotals,
  periodTotals, providerPresentation, providerTotals, rankProviders, sumTotals, tokenTypeSegments,
  PROVIDERS, type ModelTotals, type PeriodTotals, type ProviderTotals, type ShareSegment,
} from "./usageFormat";

import { ProviderMark } from "./ProviderMark";
import { loopStyle } from "../motion/Motion";
import { skeletonPulse } from "../motion/motionTokens";
export type UsageMetricKind = "cost" | "tokens";
export const CHART_HEIGHT = 144;

function ProviderDot(props: { provider: string }) {
  return <View class="flex-row items-center gap-1.5"><View class="size-1.5 rounded-full" style={{ backgroundColor: providerPresentation(props.provider).color }} /><ProviderMark provider={props.provider} size={14} /></View>;
}

function Metric(props: { label: string; value: () => string }) {
  return (
    <View class="min-w-32 flex-1 flex-col gap-0.5">
      <Text class="text-xs text-muted-foreground">{props.label}</Text>
      <Text class="text-base font-medium text-foreground">{props.value()}</Text>
    </View>
  );
}

export function ShareBar(props: { label: string; segments: () => ShareSegment[]; format: (value: number) => string; aside?: unknown }) {
  const visible = () => props.segments().filter((segment) => segment.value > 0);
  return (
    <View class="min-w-0 flex-1 flex-col gap-2.5">
      <View class="flex-row items-center justify-between gap-3">
        <Text class="text-sm font-medium text-foreground">{props.label}</Text>
        {props.aside as never}
      </View>
      <View class="h-2 flex-row gap-0.5">
        <Each of={visible()} key={(segment: ShareSegment) => segment.label}>
          {(segment) => <View class="h-2 min-w-1 rounded-sm" style={{ flexGrow: segment().value, flexBasis: 0, backgroundColor: segment().color }} />}
        </Each>
      </View>
      <View class="flex-row flex-wrap gap-x-4 gap-y-1">
        <Each of={visible()} key={(segment: ShareSegment) => segment.label}>
          {(segment) => (
            <View class="flex-row items-center gap-1.5">
              <View class="size-2 rounded-sm" style={{ backgroundColor: segment().color }} />
              <Text class="text-xs text-muted-foreground">{segment().label}</Text>
              <Text class="text-xs text-foreground">{props.format(segment().value)}</Text>
            </View>
          )}
        </Each>
      </View>
    </View>
  );
}

export function ChartColumn(props: { period: PeriodTotals; metric: () => UsageMetricKind; peak: () => number }) {
  const value = (entry: { costUsd: number; total: number }) => (props.metric() === "cost" ? entry.costUsd : entry.total);
  const segments = () =>
    PROVIDERS.flatMap((provider) => {
      const entry = props.period.byProvider[provider.key];
      const amount = entry ? value(entry) : 0;
      const peak = props.peak();
      return amount > 0 && peak > 0 ? [{ key: provider.key, color: provider.color, height: Math.max(1, (amount / peak) * CHART_HEIGHT) }] : [];
    });
  return (
    <View class="h-36 flex-1 flex-col justify-end gap-px">
      <Each of={segments()} key={(segment: { key: string; color: string; height: number }) => segment.key}>
        {(segment) => <View class="w-full rounded-sm" style={{ height: segment().height, backgroundColor: segment().color }} />}
      </Each>
    </View>
  );
}

function hourLabel(key: string): string {
  const date = new Date(key);
  return Number.isNaN(date.getTime()) ? key : `${String(date.getUTCHours()).padStart(2, "0")}:00`;
}

export function UsageOverview(props: {
  result: () => UsageResult;
  metric: () => UsageMetricKind;
  window: () => { sinceDay: string; untilDay: string; hourly: boolean };
  breakdown: () => "model" | "time";
  onBreakdown: (tab: "model" | "time") => void;
  onModel?: (provider: string, model: string) => void;
  /** Some selected environment shares a ChatGPT subscription: the "ChatGPT shared usage" row. */
  showChatGptSharing?: () => boolean;
}) {
  const chartMode = signal<"line" | "bar">("line");
  const unpricedOpen = signal(false);
  const unpricedAnchor = createAnchor();
  // UsagePage.tsx: the unpriced-usage PopoverTrigger opens on hover too.
  const unpricedHover = hoverOpen((next) => unpricedOpen.set(next));
  const peakValue = () => models().reduce((max, model) => Math.max(max, props.metric() === "tokens" ? model.total : model.costUsd), 0);
  const buckets = () => props.result().buckets;
  const totals = () => sumTotals(buckets());
  const providers = () => rankProviders(providerTotals(buckets(), props.result().sessionsByProvider), props.metric());
  const models = () => modelTotals(buckets(), props.metric()).map((model, index) => ({ ...model, rank: index + 1 }));
  const series = () => chartSeries(buckets(), props.window().sinceDay, props.window().untilDay, props.window().hourly);
  const peak = () => series().reduce((max, period) => Math.max(max, props.metric() === "cost" ? period.costUsd : period.total), 0);
  const periods = () => [...periodTotals(buckets(), props.window().hourly)].reverse();
  const unpricedShare = () => {
    const all = buckets().length;
    return all > 0 ? props.result().unpricedRecords : 0;
  };
  const activeProviders = () => providers().map((entry) => entry.provider);

  return (
    <View class="flex-col gap-6">
      <Each of={props.result().issues} key={(issue: string) => issue}>
        {(issue) => <Text class="text-sm text-muted-foreground">{issue()}</Text>}
      </Each>
      {props.result().refreshing ? <Text class="text-sm text-muted-foreground">Some usage data is refreshing. Use Refresh to load the latest results.</Text> : null}
      {props.result().pricingStatus === "unavailable" ? <Text class="text-sm text-muted-foreground">Model prices are unavailable, so cost totals are incomplete.</Text> : null}

      <View class="flex-row gap-6">
        <View class="w-72 shrink-0 flex-col gap-5">
          <View class="flex-col gap-1">
            <Text class="text-4xl font-semibold text-foreground">{props.metric() === "cost" ? formatUsd(totals().costUsd) : formatTokens(totals().total)}</Text>
            <View class="flex-row items-center gap-1">
              <Text class="text-xs text-muted-foreground">{`${formatCount(props.result().sessions)} sessions${props.metric() === "cost" ? " · API estimate" : ""}`}</Text>
              {props.metric() === "cost" && unpricedShare() > 0 ? (
                <View ref={unpricedAnchor.ref} role="button" accessibilityLabel="Unpriced usage details" onMouseEnter={unpricedHover.hover.onMouseEnter} onMouseLeave={unpricedHover.hover.onMouseLeave} onPress={() => { unpricedHover.cancel(); unpricedOpen.update((value) => !value); }} class="size-4 items-center justify-center rounded-sm">
                  <UsageIcon name="info" size={12} />
                </View>
              ) : null}
              {unpricedOpen() ? (
                <Popup animated anchor={unpricedAnchor.anchor} onClose={() => unpricedOpen.set(false)} placement="top" align="start" class="px-2 py-1">
                  <View onMouseEnter={unpricedHover.hover.onMouseEnter} onMouseLeave={unpricedHover.hover.onMouseLeave}><Text class="text-xs text-foreground">{`API estimate excludes ${formatCount(unpricedShare())} unpriced records.`}</Text></View>
                </Popup>
              ) : null}
            </View>
          </View>
          {props.showChatGptSharing?.() ? (
            <View class="flex-row items-center justify-between gap-2">
              <Text class="text-xs text-muted-foreground">ChatGPT shared usage</Text>
              <View role="button" accessibilityLabel="Manage usage" onPress={() => { void openUrl(CHATGPT_USAGE_URL); }} class="h-6 flex-row items-center gap-1.5 rounded-md px-2 hover:bg-accent">
                <Text class="text-xs text-muted-foreground">Manage usage</Text>
                <UsageIcon name="external-link" size={12} />
              </View>
            </View>
          ) : null}
          <Each of={providers()} key={(entry: ProviderTotals) => entry.provider}>
            {(entry) => (
              <View class="flex-col gap-1">
                <View class="flex-row items-baseline justify-between gap-4">
                  <View class="min-w-0 flex-row items-center gap-2">
                    <ProviderDot provider={entry().provider} />
                    <Text class="truncate text-sm text-foreground">{providerPresentation(entry().provider).label}</Text>
                    <Text class="text-2xs text-muted-foreground">{`${formatCount(entry().sessions)} ${entry().sessions === 1 ? "session" : "sessions"}`}</Text>
                  </View>
                  <Text class="text-sm font-medium text-foreground">{props.metric() === "cost" ? formatUsd(entry().costUsd) : formatTokens(entry().total)}</Text>
                </View>
                <Text class="text-xs text-muted-foreground">
                  {props.metric() === "cost"
                    ? `${formatPercent(entry().costShare)} of cost · ${formatTokens(entry().total)} tokens`
                    : `${formatPercent(entry().tokenShare)} of tokens · ${formatUsd(entry().costUsd)}`}
                </Text>
              </View>
            )}
          </Each>
        </View>

        <View class="min-w-0 flex-1 flex-col gap-3">
          <Text class="text-sm font-medium text-foreground">
            {`${props.window().hourly ? "Hourly" : "Daily"} ${props.metric() === "tokens" ? "processed tokens" : "cost"}`}
          </Text>
          <View class="flex-row gap-1 justify-end" role="tablist" accessibilityLabel="Chart type">
            {(["line", "bar"] as const).map((mode) => <View role="tab" accessibilityLabel={`${mode === "line" ? "Line" : "Bar"} chart`} onPress={() => chartMode.set(mode)} class={`rounded-md px-3 py-1 ${chartMode() === mode ? "bg-accent" : "bg-muted-30"}`}><Text class="text-xs text-foreground">{mode === "line" ? "Line" : "Bar"}</Text></View>)}
          </View>
          {chartMode() === "line" ? <UsageLineChart periods={series} metric={props.metric} /> : <View class="flex-row items-end gap-0.5">
            <Each of={series()} key={(period: PeriodTotals) => period.key}>
              {(period) => <ChartColumn period={period()} metric={props.metric} peak={peak} />}
            </Each>
          </View>}
          <View class="flex-row justify-between">
            <Text class="text-xs text-muted-foreground">{props.window().hourly ? hourLabel(series()[0]?.key ?? "") : formatDayShort(props.window().sinceDay)}</Text>
            <Text class="text-xs text-muted-foreground">{props.window().hourly ? hourLabel(series()[series().length - 1]?.key ?? "") : formatDayShort(props.window().untilDay)}</Text>
          </View>
          <View class="flex-row flex-wrap gap-x-4 gap-y-1">
            <Each of={activeProviders()} key={(provider: string) => provider}>
              {(provider) => (
                <View class="flex-row items-center gap-1.5">
                  <ProviderDot provider={provider()} />
                  <Text class="text-xs text-muted-foreground">{providerPresentation(provider()).label}</Text>
                </View>
              )}
            </Each>
          </View>
        </View>
      </View>

      <View class="flex-col gap-2">
        <Text class="text-sm font-medium text-foreground">Totals</Text>
        <View class="flex-row flex-wrap gap-x-6 gap-y-4 py-1">
          <Metric label="Processed tokens" value={() => formatTokens(totals().total)} />
          <Metric label="Cached input" value={() => formatTokens(totals().cached)} />
          <Metric label="Uncached input" value={() => formatTokens(totals().uncached)} />
          <Metric label="Output" value={() => formatTokens(totals().output)} />
          <Metric label="Cache savings" value={() => formatUsd(totals().cacheSavingsUsd)} />
        </View>
      </View>

      {totals().total > 0 ? (
        <View class="flex-row gap-12">
          {props.metric() === "tokens"
            ? <ShareBar label="Tokens by type" segments={() => tokenTypeSegments(totals())} format={formatTokens} />
            : <>
              <ShareBar label="Cost by type" segments={() => costTypeSegments(buckets())} format={formatUsd} />
              {speedCostOf(buckets()).fast + speedCostOf(buckets()).ultrafast > 0
                ? <ShareBar label="Cost by speed" segments={() => speedCostSegments(speedCostOf(buckets()))} format={formatUsd} aside={<Text class="text-xs text-muted-foreground">{`Premium ${formatUsd(speedCostOf(buckets()).premium)}`}</Text>} />
                : null}
            </>}
        </View>
      ) : null}

      <View class="flex-col gap-3">
        <View class="flex-row items-center justify-between gap-3">
          <Text class="text-sm font-medium text-foreground">Breakdown</Text>
          <View role="group" accessibilityLabel="Usage breakdown" class="flex-row items-center gap-0.5 rounded-lg bg-segmented-track p-0.5">
            <View accessibilityLabel="Model" onPress={() => props.onBreakdown("model")} class={props.breakdown() === "model" ? "rounded-md bg-segmented-active px-2.5 py-1 transition-colors duration-150 ease-in-out" : "rounded-md px-2.5 py-1 hover:bg-segmented-hover transition-colors duration-150 ease-in-out"}>
              <Text class={props.breakdown() === "model" ? "text-xs font-medium text-foreground" : "text-xs text-muted-foreground"}>Model</Text>
            </View>
            <View accessibilityLabel={props.window().hourly ? "Hour" : "Day"} onPress={() => props.onBreakdown("time")} class={props.breakdown() === "time" ? "rounded-md bg-segmented-active px-2.5 py-1 transition-colors duration-150 ease-in-out" : "rounded-md px-2.5 py-1 hover:bg-segmented-hover transition-colors duration-150 ease-in-out"}>
              <Text class={props.breakdown() === "time" ? "text-xs font-medium text-foreground" : "text-xs text-muted-foreground"}>{props.window().hourly ? "Hour" : "Day"}</Text>
            </View>
          </View>
        </View>

        {props.breakdown() === "model" ? (
          <View class="flex-col">
            <View class="flex-row border-b border-border py-2">
              <Text class="w-10 pl-2 text-xs text-muted-foreground">#</Text>
              <Text class="flex-1 text-xs text-muted-foreground">Model</Text>
              <Text class="w-28 text-right text-xs text-muted-foreground">Cost</Text>
              <Text class="w-24 text-right text-xs text-muted-foreground">Share</Text>
              <Text class="w-32 pr-2 text-right text-xs text-muted-foreground">Tokens</Text>
            </View>
            {models().length === 0 ? <Text class="py-6 text-center text-sm text-muted-foreground">No activity in this window.</Text> : null}
            <Each of={models()} key={(model: ModelTotals & { rank: number }) => `${model.provider}:${model.model}`}>
              {(model) => (
                <View accessibilityLabel={`Model ${model().model}`} role="button" onPress={() => props.onModel?.(model().provider, model().model)} class="flex-row items-center border-b border-border-50 py-2.5 hover:bg-muted-40 transition-colors duration-150 ease-in-out">
                  <Text class="w-10 pl-2 text-xs text-muted-foreground">{String(model().rank)}</Text>
                  <View class="min-w-0 flex-1 flex-col">
                    <View class="flex-row items-center gap-2">
                      <ProviderDot provider={model().provider} />
                      <Text class="truncate text-sm text-foreground">{model().model}</Text>
                    </View>
                    {(props.metric() === "tokens" ? model().total : model().costUsd) > 0 && peakValue() > 0 ? (
                      <View class="mt-1.5 h-0.5 max-w-48 flex-row">
                        <View class="h-full rounded-full" style={{ width: `${Math.max(4, ((props.metric() === "tokens" ? model().total : model().costUsd) / peakValue()) * 100)}%`, backgroundColor: providerPresentation(model().provider).color }} />
                      </View>
                    ) : null}
                  </View>
                  <Text class="w-28 text-right text-sm text-foreground">{model().costUsd === 0 && model().total > 0 ? "Unpriced" : formatUsd(model().costUsd)}</Text>
                  <Text class="w-24 text-right text-sm text-muted-foreground">{formatPercent(props.metric() === "tokens" ? model().tokenShare : model().costShare)}</Text>
                  <Text class="w-32 pr-2 text-right text-sm text-muted-foreground">{formatTokens(model().total)}</Text>
                </View>
              )}
            </Each>
          </View>
        ) : (
          <View class="flex-col" role="region" accessibilityLabel="Usage breakdown by time">
            <View class="flex-row border-b border-border py-2">
              <Text class="w-40 pl-2 text-xs text-muted-foreground">{props.window().hourly ? "Hour" : "Day"}</Text>
              <Each of={activeProviders()} key={(provider: string) => provider}>
                {(provider) => <Text class="flex-1 text-right text-xs text-muted-foreground">{providerPresentation(provider()).label}</Text>}
              </Each>
              <Text class="w-24 text-right text-xs text-muted-foreground">Total</Text>
              <Text class="w-32 pr-2 text-right text-xs text-muted-foreground">Tokens</Text>
            </View>
            {periods().length === 0 ? <Text class="py-6 text-center text-sm text-muted-foreground">No activity in this window.</Text> : null}
            <Each of={periods()} key={(period: PeriodTotals) => period.key}>
              {(period) => (
                <View class="flex-row items-center border-b border-border-50 py-2 hover:bg-muted-40 transition-colors duration-150 ease-in-out">
                  <Text class="w-40 pl-2 text-sm text-foreground">{props.window().hourly ? hourLabel(period().key) : formatDayShort(period().key)}</Text>
                  <Each of={activeProviders()} key={(provider: string) => provider}>
                    {(provider) => <Text class="flex-1 text-right text-sm text-muted-foreground">{formatUsd(period().byProvider[provider()]?.costUsd ?? 0)}</Text>}
                  </Each>
                  <Text class="w-24 text-right text-sm text-foreground">{formatUsd(period().costUsd)}</Text>
                  <Text class="w-32 pr-2 text-right text-sm text-muted-foreground">{formatTokens(period().total)}</Text>
                </View>
              )}
            </Each>
          </View>
        )}
      </View>
    </View>
  );
}

export function UsageSkeleton(props: { message: string }) {
  const bar = "rounded-md bg-muted";
  return (
    <View class="flex-col gap-6" accessibilityLabel="Loading usage">
      <Text class="text-sm text-muted-foreground">{props.message}</Text>
      <View class="flex-row gap-6" style={loopStyle(skeletonPulse)}>
        <View class="w-72 flex-col gap-5">
          <View class="flex-col gap-1"><View class={`h-10 w-36 ${bar}`} /><View class={`h-4 w-32 ${bar}`} /></View>
          <Each of={PROVIDERS.slice(0, 4)} key={(p: { key: string }) => p.key}>
            {() => <View class="flex-col gap-1"><View class={`h-3.5 w-40 ${bar}`} /><View class={`h-4 w-36 ${bar}`} /></View>}
          </Each>
        </View>
        <View class="min-w-0 flex-1 flex-col gap-3"><View class={`h-5 w-24 ${bar}`} /><View class={`h-56 ${bar}`} /></View>
      </View>
      <View class="flex-col gap-2">
        <Text class="text-sm font-medium text-foreground">Totals</Text>
        <View class="flex-row gap-6">
          <Each of={["Processed tokens", "Cached input", "Uncached input", "Output", "Cache savings"]} key={(label: string) => label}>
            {(label) => <View class="min-w-32 flex-1 flex-col gap-1"><Text class="text-xs text-muted-foreground">{label()}</Text><View class={`h-6 w-16 ${bar}`} /></View>}
          </Each>
        </View>
      </View>
    </View>
  );
}

function UsageLineChart(props: { periods: () => PeriodTotals[]; metric: () => UsageMetricKind }) {
  const width = signal(500);
  const height = 180;
  const amount = (period: PeriodTotals, provider: string) => {
    const entry = period.byProvider[provider];
    return entry ? props.metric() === "cost" ? entry.costUsd : entry.total : 0;
  };
  const maximum = () => Math.max(1, ...props.periods().flatMap((period) => PROVIDERS.map((provider) => amount(period, provider.key))));
  const source = () => {
    const w = Math.max(100, width());
    const max = maximum();
    const paths = PROVIDERS.map((provider) => {
      const points = props.periods().map((period, index, all) => `${index === 0 ? "M" : "L"}${48 + index * (w - 50) / Math.max(1, all.length - 1)},${height - 4 - amount(period, provider.key) / max * (height - 12)}`).join(" ");
      return `<path d="${points}" fill="none" stroke="${provider.color}" stroke-width="1.5" stroke-linejoin="round"/>`;
    }).join("");
    const grid = [0, 0.5, 1].map((fraction) => {
      const y = height - 4 - fraction * (height - 12);
      const label = props.metric() === "cost" ? formatUsd(max * fraction) : formatTokens(max * fraction);
      return `<path d="M48 ${y}H${w}" stroke="#465563" stroke-opacity=".6"/><text x="0" y="${Math.max(9, y)}" font-size="8" fill="#929da7">${label}</text>`;
    }).join("");
    return "data:image/svg+xml;base64," + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}">${grid}${paths}</svg>`);
  };
  return <View onLayout={(event) => width.set(event.bounds.size.width)} style={{ height }} accessibilityLabel="Usage by provider line chart"><Image src={source()} style={{ width: "100%", height }} /></View>;
}
