import { openUsage, settingValue } from "../../store";
// The thread details card's Usage limits and Context window items (chat/ThreadDetailsUsage.tsx):
// one hairline row per limit window reading as room left, and one for the thread's context window
// with a tick where auto-compaction starts. Each row's whole surface opens a tooltip on the left.
import { asTimestampFormat } from "../thread/timestampFormat";
import { formatUpcomingTimestamp } from "../banners/bannerLogic";
import { Text, View } from "nsh";
import { Tooltip } from "nsh/base";
import { formatDuration, paceOf, paceRemainingPercent, PACE_LABEL, remainingPercent } from "../usage/usageFormat";
import type { UsageLimitWindow } from "../../pages/utility-data";
import { formatContextWindowTokens, type TokenUsage } from "../composer/threadProviderState";
import type { LimitsView } from "../composer/usageLimitsLogic";
import { DetailsSection } from "./ThreadDetailsSections";

export type UsageTone = "error" | "warning" | null;

/** compaction.logic.ts formatContextWindowCompactionMessage. */
export function compactionMessage(threshold?: number | null): string {
  return typeof threshold === "number" && threshold > 0
    ? `Compacts automatically at about ${threshold.toLocaleString("en-US")} tokens.`
    : "Context compacts automatically when needed.";
}

export interface ContextRowModel {
  used: number | null;
  tone: UsageTone;
  tick: number | null;
  value: string;
  ariaValue: string;
  lines: string[];
}

/** ThreadDetailsContext's numbers: percent used, the bar tone, the compaction tick and the tooltip lines. */
export function contextRowModel(usage: TokenUsage & { autoCompactThreshold?: number | null }): ContextRowModel {
  const max = usage.maxTokens !== null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const used = max !== null ? Math.round(Math.max(0, Math.min(100, (usage.usedTokens / max) * 100))) : null;
  const threshold = usage.autoCompactThreshold ?? null;
  const tick = max !== null && threshold !== null && threshold > 0 && threshold < max ? (threshold / max) * 100 : null;
  const usedTokens = formatContextWindowTokens(usage.usedTokens);
  return {
    used,
    tone: used === null ? null : used >= 90 ? "error" : used >= 80 ? "warning" : null,
    tick,
    value: max !== null ? `${usedTokens} / ${formatContextWindowTokens(max)}` : usedTokens,
    ariaValue: used !== null ? `${used}% used` : `${usedTokens} tokens used`,
    lines: [
      used !== null ? `Context: ${used}% used` : `Context: ${usedTokens} tokens used`,
      ...(max !== null ? [`${usage.usedTokens.toLocaleString("en-US")} of ${max.toLocaleString("en-US")} tokens`] : []),
      // ThreadDetailsContext: the compaction line shows only with a known threshold.
      ...(threshold !== null && threshold > 0 ? [compactionMessage(threshold)] : []),
    ],
  };
}

function limitTone(left: number): UsageTone {
  return left <= 10 ? "error" : left <= 20 ? "warning" : null;
}

function toWindow(window: LimitsView["windows"][number]): UsageLimitWindow {
  return { id: window.id, label: window.label, usedPercent: window.usedPercent, resetsAt: window.resetsAt ?? "", windowDurationMins: window.windowDurationMins };
}

/** ThreadDetailsUsage: the reset time as formatUpcomingTimestamp shows it, in the reader's timestamp format. */
function resetClock(iso: string, now: number): string {
  return formatUpcomingTimestamp(iso, asTimestampFormat(settingValue("timestampFormat")), now);
}

interface RowProps {
  label: string;
  fill: number | null;
  tone: UsageTone;
  tick?: number | null;
  value: string;
  ariaValue?: string;
  lines: string[];
  muted?: boolean;
  opensUsage?: boolean;
  labelWidth: number;
}

/** One label, hairline and value row; the whole row carries the details tooltip. */
function UsageRow(props: RowProps) {
  const fillClass = props.tone === "error" ? "bg-error" : props.tone === "warning" ? "bg-warning" : props.muted ? "bg-muted-foreground" : "bg-foreground opacity-80";
  const valueClass = props.tone === "error" ? "text-error-foreground" : props.tone === "warning" ? "text-warning-foreground" : props.fill === null ? "text-muted-foreground" : "text-foreground opacity-80";
  return (
    <View
      role={props.opensUsage ? "button" : undefined}
      onPress={props.opensUsage ? () => openUsage() : undefined}
      accessibilityLabel={`${props.label}: ${props.ariaValue ?? props.value}`}
      tooltip={
        <Tooltip class="max-w-80 gap-0.5 rounded-md border border-border bg-popover px-2 py-1">
          {props.lines.map((line, index) => <Text class={index === 0 ? "text-xs text-foreground" : "text-xs text-muted-foreground"}>{line}</Text>)}
        </Tooltip>
      }
      class="h-6 w-full flex-row items-center gap-3 rounded-lg px-2.5 hover:bg-details-row-hover"
    >
      <Text class="shrink-0 truncate text-xs text-muted-foreground" style={{ width: props.labelWidth }}>{props.label}</Text>
      {props.fill !== null ? (
        <View class="relative h-[3px] min-w-12 flex-1 rounded-full">
          <View class="absolute inset-0 rounded-full bg-muted-foreground opacity-30" />
          {props.fill > 0 ? <View class={`absolute inset-y-0 left-0 rounded-full ${fillClass}`} style={{ width: `${Math.max(props.fill, 3)}%` }} /> : null}
          {props.tick !== null && props.tick !== undefined ? <View class="absolute -top-[3px] h-[9px] w-px bg-foreground opacity-60" style={{ left: `${props.tick}%` }} /> : null}
        </View>
      ) : <View class="flex-1" />}
      <Text class={`shrink-0 text-right text-xs font-medium ${valueClass}`}>{props.value}</Text>
    </View>
  );
}

/** The label column is as wide as the widest label, up to max-w-28 (the grid's auto column). */
function labelColumn(labels: readonly string[]): number {
  return Math.min(112, Math.ceil(Math.max(0, ...labels.map((label) => label.length)) * 6.6));
}

/** The selected provider's limit windows. Each row reads as room left. */
export function ThreadDetailsUsage(props: { limits: () => LimitsView | null; now?: () => number }) {
  const now = () => (props.now ?? Date.now)();
  const limits = () => props.limits();
  return (
    <>
      {limits() ? (
        <DetailsSection id="usage" title="Usage limits" showHeading={false}>
          {limits()!.notice ? (
            <UsageRow label="Limits" fill={null} tone={null} value="Unavailable" opensUsage lines={[limits()!.notice!]} labelWidth={labelColumn(["Limits"])} />
          ) : (
            limits()!.windows.map((window) => {
              const view = toWindow(window);
              const left = remainingPercent(view);
              const resets = window.resetsAt && Date.parse(window.resetsAt) > now() ? Date.parse(window.resetsAt) : null;
              const pace = paceOf(view, now());
              const timeLeft = paceRemainingPercent(view, now());
              return (
                <UsageRow
                  label={window.label}
                  fill={left}
                  tone={limitTone(left)}
                  tick={timeLeft}
                  value={`${left}%`}
                  ariaValue={`${left}% left`}
                  opensUsage
                  labelWidth={labelColumn(limits()!.windows.map((entry) => entry.label))}
                  lines={[
                    `${window.label}: ${left}% left`,
                    ...(pace && timeLeft !== null ? [`${PACE_LABEL[pace]} · ${timeLeft}% of the window left`] : pace ? [PACE_LABEL[pace]] : []),
                    ...(resets !== null ? [`Resets in ${formatDuration(resets - now())} · ${resetClock(window.resetsAt!, now())}`] : []),
                  ]}
                />
              );
            })
          )}
        </DetailsSection>
      ) : null}
    </>
  );
}

/** The thread's context window. The bar fills as context is used; the tick marks auto-compaction. */
export function ThreadDetailsContext(props: { usage: () => (TokenUsage & { autoCompactThreshold?: number | null }) | null }) {
  const model = () => { const usage = props.usage(); return usage ? contextRowModel(usage) : null; };
  return (
    <>
      {model() ? (
        <DetailsSection id="context" title="Context window" showHeading={false}>
          <UsageRow label="Context" fill={model()!.used} tone={model()!.tone} tick={model()!.tick} muted value={model()!.value} ariaValue={model()!.ariaValue} lines={model()!.lines} labelWidth={labelColumn(["Context"])} />
        </DetailsSection>
      ) : null}
    </>
  );
}
