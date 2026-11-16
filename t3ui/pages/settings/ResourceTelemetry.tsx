// The resource telemetry sections of the diagnostics page, ported from ResourceTelemetryDiagnostics.tsx:
// Resource monitor (the T3 footprint, six stats and the backend / desktop / monitor aggregates), Host & collection
// (host power state and collector health, with Retry monitor), Resource timeline (a CPU and I/O bar chart and the
// top processes of a window), Live process tree (collapsible, with SIGINT / SIGKILL for processes T3 owns) and
// Instrumented application I/O.
//
// Reads the `subscribeResourceTelemetry` stream, `server.getResourceTelemetryHistory` (refreshed every five seconds)
// and sends `server.signalProcess` / `server.retryResourceTelemetry`, all through the deps so a test supplies its own.
import { effect, signal, Text, token, untracked, View } from "nsh";
import { tokenAlpha } from "../../components/composer/tokenColor";
import { Icon } from "../../components/Icons";
import { Tip } from "./providers/ui";
import { DiagnosticsIcon } from "./DiagnosticsIcon";
import {
  Cell, DataTable, Divider, EmptyRow, ErrorBlock, ErrorLine, IconAction, IconSection, MonoText, RefreshAction, RelativeLabel, TableRow, WindowSelector, columnWidths,
  type Tone,
} from "./DiagnosticsParts";
import {
  parseTelemetryHistory, parseTelemetryRetryResult, parseTelemetrySnapshot,
  type TelemetryAggregate, type TelemetryHistory, type TelemetryProcess, type TelemetryProcessSummary, type TelemetrySnapshot, type TelemetrySourceHealth, type TelemetrySourceStatus,
} from "./resourceTelemetryData";
import {
  booleanStateLabel, canSignalProcess, categoryDotToken, categoryLabel, formatBytes, formatCpuTimeMs, formatDurationMicros, formatProcessName, formatRate, formatSampleInterval,
  ioSemanticsLabel, processIdentityKey, resourceHistoryBarHeight, resourceHistoryCpuScaleMax, shouldShowResourceMonitorRetry, sourceStatusTone, visibleResourceTelemetryProcesses, categoryLabel as label,
} from "./resourceTelemetryLogic";

export interface TelemetryDeps {
  request: (method: string, payload: unknown) => Promise<unknown>;
  subscribe: (method: string, payload: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void) => () => void;
  confirm: (message: string) => Promise<boolean>;
  toast: (toast: { type: "error" | "info"; title: string; description: string }) => void;
}

export const HISTORY_WINDOWS = [
  { label: "5m", windowMs: 5 * 60_000, bucketMs: 15_000 },
  { label: "15m", windowMs: 15 * 60_000, bucketMs: 30_000 },
  { label: "30m", windowMs: 30 * 60_000, bucketMs: 60_000 },
  { label: "1h", windowMs: 60 * 60_000, bucketMs: 2 * 60_000 },
] as const;

const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);
const mutedAlpha = (alpha: number) => tokenAlpha("muted-foreground", alpha);
const VIOLET = "#8b5cf6";

function dotColor(category: TelemetryProcess["category"]) {
  const kind = categoryDotToken(category);
  return kind === "violet" ? VIOLET : token(kind);
}

function SourceStatusBadge(props: { label: string; status: TelemetrySourceStatus; neutralLabel?: string }) {
  const tone = props.neutralLabel ? "neutral" : sourceStatusTone(props.status);
  const color = tone === "neutral" ? tokenAlpha("muted-foreground", 0.55) : tone === "default" ? token("success") : tone === "warning" ? token("warning") : token("destructive");
  const border = tone === "neutral" ? tokenAlpha("border", 0.7) : tone === "default" ? tokenAlpha("success", 0.25) : tone === "warning" ? tokenAlpha("warning", 0.3) : tokenAlpha("destructive", 0.3);
  const fill = tone === "neutral" ? tokenAlpha("muted", 0.45) : tone === "default" ? tokenAlpha("success", 0.1) : tone === "warning" ? tokenAlpha("warning", 0.1) : tokenAlpha("destructive", 0.1);
  const text = tone === "neutral" ? "text-muted-foreground" : tone === "default" ? "text-success-foreground" : tone === "warning" ? "text-warning-foreground" : "text-destructive";
  return (
    <View class="flex-row items-center gap-1.5 rounded-full border px-2.5 py-1" style={{ borderColor: border, backgroundColor: fill }}>
      <View class="size-1.5 rounded-full" style={{ backgroundColor: color }} />
      <Text class={`text-3xs font-semibold uppercase tracking-widest ${text}`}>{`${props.label} ${props.neutralLabel ?? props.status}`.trim()}</Text>
    </View>
  );
}

function IconStat(props: { icon: string; label: string; value: string; detail?: string | undefined; tone?: Tone }) {
  return (
    <View class="min-w-0 flex-1 px-5 py-4" testID={`Telemetry ${props.label}`}>
      <View class="flex-row items-center gap-2">
        <DiagnosticsIcon name={props.icon} size={14} tint={mutedAlpha(0.55)} />
        <Text class="min-w-0 truncate text-3xs font-semibold uppercase tracking-widest" style={{ color: mutedAlpha(0.7) }}>{props.label}</Text>
      </View>
      <Text class={`mt-2.5 truncate font-mono text-2xl font-semibold ${props.tone === "danger" ? "text-destructive" : props.tone === "warning" ? "text-warning-foreground" : "text-foreground"}`}>{props.value}</Text>
      {props.detail ? <Text class="mt-1.5 truncate text-3xs" style={{ color: mutedAlpha(0.6) }}>{props.detail}</Text> : null}
    </View>
  );
}

function MetricPair(props: { label: string; value: string }) {
  return (
    <View class="min-w-0 flex-1">
      <Text class="text-3xs font-semibold uppercase tracking-widest" style={{ color: mutedAlpha(0.45) }}>{props.label}</Text>
      <Text class="truncate font-mono text-xs font-medium" style={{ color: tokenAlpha("foreground", 0.9) }}>{props.value}</Text>
    </View>
  );
}

function AggregateCard(props: { label: string; accent: string; aggregate: TelemetryAggregate; first?: boolean }) {
  const a = props.aggregate;
  return (
    <View class={`min-w-0 flex-1 px-5 py-4 ${props.first ? "" : "border-l border-border-60"}`} testID={`Aggregate ${props.label}`}>
      <View class="absolute left-5 right-5 top-0 h-0.5 rounded-full opacity-75" style={{ backgroundColor: props.accent }} />
      <View class="flex-row items-center justify-between gap-3">
        <Text class="text-3xs font-semibold uppercase tracking-widest" style={{ color: mutedAlpha(0.75) }}>{props.label}</Text>
        <View class="rounded-md px-1.5 py-0.5" style={{ backgroundColor: tokenAlpha("muted", 0.55) }}>
          <Text class="font-mono text-3xs" style={{ color: mutedAlpha(0.7) }}>{`${a.processCount} ${a.processCount === 1 ? "process" : "processes"}`}</Text>
        </View>
      </View>
      <View class="mt-3.5 gap-2.5">
        <View class="flex-row gap-4"><MetricPair label="CPU" value={`${a.currentCpuPercent.toFixed(1)}%`} /><MetricPair label="Memory" value={formatBytes(a.currentRssBytes)} /></View>
        <View class="flex-row gap-4"><MetricPair label="Read" value={formatRate(a.ioReadBytesPerSecond)} /><MetricPair label="Write" value={formatRate(a.ioWriteBytesPerSecond)} /></View>
      </View>
    </View>
  );
}

function DetailRow(props: { label: string; value: string; tone?: "destructive" | "warning"; first?: boolean }) {
  return (
    <View class={`flex-row items-center justify-between gap-4 py-2.5 ${props.first ? "" : "border-t border-border-50"}`}>
      <Text class="text-2xs" style={{ color: mutedAlpha(0.75) }}>{props.label}</Text>
      <Text class={`min-w-0 truncate text-right font-mono text-2xs ${props.tone === "destructive" ? "text-destructive" : props.tone === "warning" ? "text-warning-foreground" : ""}`} style={props.tone ? undefined : { color: tokenAlpha("foreground", 0.85) }}>{props.value}</Text>
    </View>
  );
}

function HealthSource(props: { label: string; health: TelemetrySourceHealth; first?: boolean }) {
  const expectedInBrowser = props.health.status === "unavailable" && props.health.lastError !== null && props.health.lastError.includes("'web' mode");
  return (
    <View class={`flex-row items-start justify-between gap-4 py-3 ${props.first ? "" : "border-t border-border-50"}`}>
      <View class="min-w-0 flex-1">
        <Text class="text-sm font-medium text-foreground">{props.label}</Text>
        <Text class="mt-1 text-2xs leading-relaxed" style={{ color: mutedAlpha(0.65) }}>
          {expectedInBrowser ? "Available when this page runs inside the desktop app." : props.health.lastError ?? "No reported errors"}
        </Text>
      </View>
      <SourceStatusBadge label="" status={props.health.status} neutralLabel={expectedInBrowser ? "Desktop only" : undefined} />
    </View>
  );
}

function PanelTitle(props: { icon: string; title: string }) {
  return (
    <View class="mb-3 flex-row items-center gap-2">
      <View class="size-6 items-center justify-center rounded-md" style={{ backgroundColor: tokenAlpha("muted", 0.6) }}><DiagnosticsIcon name={props.icon} size={14} tint={token("muted-foreground")} /></View>
      <Text class="text-3xs font-semibold uppercase tracking-widest" style={{ color: mutedAlpha(0.7) }}>{props.title}</Text>
    </View>
  );
}

const CHART_INNER_HEIGHT = 104;

function ResourceHistoryChart(props: { buckets: () => TelemetryHistory["buckets"] }) {
  const maxCpu = () => resourceHistoryCpuScaleMax(props.buckets());
  const maxIo = () => Math.max(1, ...props.buckets().map((bucket) => bucket.ioReadBytes + bucket.ioWriteBytes));
  const bar = (value: number, max: number, minimum: number) => Math.round((resourceHistoryBarHeight({ value, max, minimumVisiblePercent: minimum }) / 100) * CHART_INNER_HEIGHT);
  const legend = (color: string, text: string) => (
    <View class="flex-row items-center gap-1.5"><View class="h-1.5 w-3 rounded-full" style={{ backgroundColor: color }} /><Text class="text-3xs" style={{ color: mutedAlpha(0.65) }}>{text}</Text></View>
  );
  return (
    <View class="border-t border-border-60 px-5 py-4" testID="Resource history chart">
      <View class="mb-3 flex-row flex-wrap items-center gap-x-4 gap-y-1">
        {legend(tokenAlpha("foreground", 0.7), "CPU average")}
        {legend(tokenAlpha("info", 0.7), "I/O reads")}
        {legend(tokenAlpha("warning", 0.8), "I/O writes")}
      </View>
      <View class="h-32 flex-row items-end gap-1 overflow-hidden rounded-lg border border-border-50 px-2 pb-2 pt-3" style={{ backgroundColor: tokenAlpha("muted", 0.08) }}>
        <Each of={props.buckets()} key={(bucket) => bucket.startedAt}>
          {(bucket) => (
            <View
              class="h-full min-w-1 flex-1 flex-row items-end gap-px"
              tooltip={<Tip><View class="gap-0.5"><Text class="text-xs text-popover-foreground">{`CPU avg ${bucket().avgCpuPercent.toFixed(1)}%`}</Text><Text class="text-xs text-popover-foreground">{`CPU peak ${bucket().maxCpuPercent.toFixed(1)}%`}</Text><Text class="text-xs text-popover-foreground">{`Read ${formatBytes(bucket().ioReadBytes)}`}</Text><Text class="text-xs text-popover-foreground">{`Write ${formatBytes(bucket().ioWriteBytes)}`}</Text></View></Tip>}
            >
              <View class="flex-1 rounded-t-sm" style={{ height: bar(bucket().avgCpuPercent, maxCpu(), 2), backgroundColor: tokenAlpha("foreground", 0.65) }} />
              <View class="flex-1 rounded-t-sm" style={{ height: bar(bucket().ioReadBytes, maxIo(), 1), backgroundColor: tokenAlpha("info", 0.7) }} />
              <View class="flex-1 rounded-t-sm" style={{ height: bar(bucket().ioWriteBytes, maxIo(), 1), backgroundColor: tokenAlpha("warning", 0.8) }} />
            </View>
          )}
        </Each>
      </View>
    </View>
  );
}

const HISTORY_COLUMNS = [24, 11, 10, 10, 11, 11, 11, 7, 5];
const HISTORY_TOTAL = 1020;

function HistoryProcessTable(props: { processes: () => TelemetryProcessSummary[] }) {
  const widths = columnWidths(HISTORY_TOTAL, HISTORY_COLUMNS);
  return (
    <View class="border-t border-border-60" testID="Resource history processes">
      <DataTable total={HISTORY_TOTAL} percents={HISTORY_COLUMNS} headers={["Process", "Category", "CPU Time", "Peak CPU", "Peak Mem", "Read", "Write", "Samples", "PID"]} right={[false, false, true, true, true, true, true, true, true]}>
        {props.processes().length === 0 ? <EmptyRow label="No retained process samples in this window." /> : null}
        <Each of={props.processes()} key={(process) => processIdentityKey(process)}>
          {(process) => (
            <TableRow widths={widths}>
              <Cell width={widths[0]!} first><View tooltip={<Tip label={process().command || process().name} />}><Text class="truncate text-xs font-medium text-foreground">{process().name || process().command}</Text></View></Cell>
              <Cell width={widths[1]!}><Text class="truncate text-2xs text-muted-foreground">{label(process().category)}</Text></Cell>
              <Cell width={widths[2]!} right><MonoText>{formatCpuTimeMs(process().cpuTimeMs)}</MonoText></Cell>
              <Cell width={widths[3]!} right><MonoText>{`${process().maxCpuPercent.toFixed(1)}%`}</MonoText></Cell>
              <Cell width={widths[4]!} right><MonoText>{formatBytes(process().peakRssBytes)}</MonoText></Cell>
              <Cell width={widths[5]!} right><MonoText tone="info">{formatBytes(process().ioReadBytes)}</MonoText></Cell>
              <Cell width={widths[6]!} right><MonoText tone="warning">{formatBytes(process().ioWriteBytes)}</MonoText></Cell>
              <Cell width={widths[7]!} right><MonoText tone="muted">{String(process().sampleCount)}</MonoText></Cell>
              <Cell width={widths[8]!} right><MonoText tone="muted">{String(process().identity.pid)}</MonoText></Cell>
            </TableRow>
          )}
        </Each>
      </DataTable>
    </View>
  );
}

const TREE_COLUMNS = [20, 10, 7, 8, 9, 9, 9, 10, 8, 6, 4];
const TREE_TOTAL = 1320;

function ProcessTable(props: {
  processes: () => TelemetryProcess[]; canMaintain: boolean; signalingKeys: () => ReadonlySet<string>; onSignal: (process: TelemetryProcess, signal: "SIGINT" | "SIGKILL") => void;
}) {
  const collapsed = signal<ReadonlySet<string>>(new Set());
  const visible = () => visibleResourceTelemetryProcesses(props.processes(), collapsed());
  const widths = columnWidths(TREE_TOTAL, TREE_COLUMNS);
  const toggle = (process: TelemetryProcess) => {
    const key = processIdentityKey(process);
    const next = new Set(collapsed());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsed.set(next);
  };
  return (
    <View class="border-t border-border-60" testID="Resource process tree">
      <DataTable total={TREE_TOTAL} percents={TREE_COLUMNS} headers={["Process", "Category", "CPU", "CPU Time", "Memory", "Read/s", "Write/s", "Read Total", "Write Total", "PID", "Kill"]} right={[false, false, true, true, true, true, true, true, true, true, true]}>
        {visible().length === 0 ? <EmptyRow label="Waiting for the native process monitor." /> : null}
        <Each of={visible()} key={(process) => processIdentityKey(process)}>
          {(process) => {
            const row = process();
            const name = formatProcessName(row);
            const key = processIdentityKey(row);
            return (
              <TableRow widths={widths} testID={`Process ${row.identity.pid}`}>
                <Cell width={widths[0]!} first>
                  <View class="min-w-0 flex-row items-center gap-2" style={{ paddingLeft: Math.min(row.depth, 7) * 10 }}>
                    {row.childPids.length > 0 ? (
                      <View role="button" accessibilityLabel={collapsed().has(key) ? `Expand ${name}` : `Collapse ${name}`} class="size-5 items-center justify-center rounded-md hover:bg-accent" onPress={() => toggle(row)}>
                        <Icon name={collapsed().has(key) ? "chevron-right" : "chevron-down"} size={14} tint={token("muted-foreground")} />
                      </View>
                    ) : <View class="size-5" />}
                    <View class="size-1.5 rounded-full" style={{ backgroundColor: dotColor(row.category) }} />
                    <View class="min-w-0 flex-1" tooltip={<Tip label={row.command || row.name} />}><Text class="truncate text-xs font-medium text-foreground">{name}</Text></View>
                  </View>
                </Cell>
                <Cell width={widths[1]!}><Text class="truncate text-2xs text-muted-foreground">{categoryLabel(row.category)}</Text></Cell>
                <Cell width={widths[2]!} right><MonoText>{`${row.cpuPercent.toFixed(1)}%`}</MonoText></Cell>
                <Cell width={widths[3]!} right><MonoText>{formatCpuTimeMs(row.cpuTimeMs)}</MonoText></Cell>
                <Cell width={widths[4]!} right><MonoText>{formatBytes(row.residentBytes)}</MonoText></Cell>
                <Cell width={widths[5]!} right><MonoText tone="info">{formatRate(row.ioReadBytesPerSecond)}</MonoText></Cell>
                <Cell width={widths[6]!} right><MonoText tone="warning">{formatRate(row.ioWriteBytesPerSecond)}</MonoText></Cell>
                <Cell width={widths[7]!} right><MonoText tone="muted">{formatBytes(row.ioReadBytes)}</MonoText></Cell>
                <Cell width={widths[8]!} right><View tooltip={<Tip label={ioSemanticsLabel(row.ioSemantics)} />}><MonoText tone="muted">{formatBytes(row.ioWriteBytes)}</MonoText></View></Cell>
                <Cell width={widths[9]!} right><MonoText tone="muted">{String(row.identity.pid)}</MonoText></Cell>
                <Cell width={widths[10]!} right>
                  {canSignalProcess(row) ? (
                    <View class="flex-row items-center justify-end gap-1.5">
                      <View role="button" accessibilityLabel="Send SIGINT" disabled={!props.canMaintain || props.signalingKeys().has(key)} onPress={() => props.onSignal(row, "SIGINT")} tooltip={<Tip label="Send SIGINT" />}><Text class="text-xs text-muted-foreground underline">INT</Text></View>
                      <View role="button" accessibilityLabel="Send SIGKILL" disabled={!props.canMaintain || props.signalingKeys().has(key)} onPress={() => props.onSignal(row, "SIGKILL")} tooltip={<Tip label="Send SIGKILL" />}><Text class="text-xs text-destructive-foreground underline">KILL</Text></View>
                    </View>
                  ) : <Text class="text-3xs" style={{ color: mutedAlpha(0.35) }}>-</Text>}
                </Cell>
              </TableRow>
            );
          }}
        </Each>
      </DataTable>
    </View>
  );
}

const ATTRIBUTION_COLUMNS = [22, 28, 14, 14, 10, 12];
const ATTRIBUTION_TOTAL = 720;

export function ResourceTelemetryDiagnostics(props: { deps: TelemetryDeps; active: boolean; environmentKey: string; canMaintain?: boolean }) {
  const canMaintain = props.canMaintain ?? true;
  const deps = props.deps;
  const snapshot = signal<TelemetrySnapshot | null>(null);
  const streamError = signal<string | null>(null);
  const streamPending = signal(false);
  const history = signal<TelemetryHistory | null>(null);
  const historyError = signal<string | null>(null);
  const historyPending = signal(false);
  const windowMs = signal<number>(15 * 60_000);
  const signalingKeys = signal<ReadonlySet<string>>(new Set());
  const retrying = signal(false);
  let stop: (() => void) | null = null;
  let historySerial = 0;

  const selectedWindow = () => HISTORY_WINDOWS.find((option) => option.windowMs === windowMs()) ?? HISTORY_WINDOWS[1];

  function startStream() {
    stop?.();
    streamPending.set(true);
    const mine = stop = deps.subscribe("subscribeResourceTelemetry", {}, (value) => {
      if (stop !== mine) return;
      try {
        snapshot.set(parseTelemetrySnapshot(value));
        streamError.set(null);
      } catch (cause) {
        streamError.set(errorText(cause, "Invalid diagnostics response."));
      }
      streamPending.set(false);
    }, (cause) => {
      if (stop !== mine) return;
      streamError.set(errorText(cause, "The environment request failed."));
      streamPending.set(false);
    });
  }

  async function refreshHistory() {
    const serial = ++historySerial;
    const selected = selectedWindow();
    historyPending.set(true);
    try {
      const result = parseTelemetryHistory(await deps.request("server.getResourceTelemetryHistory", { windowMs: selected.windowMs, bucketMs: selected.bucketMs }));
      if (serial !== historySerial) return;
      history.set(result);
      historyError.set(null);
    } catch (cause) {
      if (serial === historySerial) historyError.set(errorText(cause, "The environment request failed."));
    } finally {
      if (serial === historySerial) historyPending.set(false);
    }
  }

  effect(() => {
    const live = props.active;
    void props.environmentKey;
    if (!live) {
      untracked(() => { stop?.(); stop = null; snapshot.set(null); streamError.set(null); streamPending.set(false); });
      return undefined;
    }
    untracked(startStream);
    return () => { stop?.(); stop = null; };
  });

  effect(() => {
    const live = props.active;
    void props.environmentKey;
    void windowMs();
    if (!live) {
      untracked(() => { historySerial++; history.set(null); historyError.set(null); historyPending.set(false); });
      return undefined;
    }
    untracked(() => void refreshHistory());
    // In-flight guard: a slow server must not stack a second history request on top of one still waiting.
    const timer = setInterval(() => { if (!historyPending()) void refreshHistory(); }, 5_000);
    return () => { clearInterval(timer); historySerial++; };
  });

  async function signalProcess(process: TelemetryProcess, signalName: "SIGINT" | "SIGKILL") {
    const key = processIdentityKey(process);
    if (!canMaintain || signalingKeys().has(key)) return;
    signalingKeys.set(new Set(signalingKeys()).add(key));
    const clear = () => { const next = new Set(signalingKeys()); next.delete(key); signalingKeys.set(next); };
    try {
      if (signalName === "SIGKILL") {
        let confirmed = false;
        try {
          confirmed = await deps.confirm(`Send SIGKILL to process ${process.identity.pid}? This cannot be handled by the process.`);
        } catch (cause) {
          deps.toast({ type: "error", title: "Could not confirm signal", description: errorText(cause, `Failed to send ${signalName}.`) });
          return;
        }
        if (!confirmed) return;
      }
      try {
        const result = await deps.request("server.signalProcess", { pid: process.identity.pid, startTimeMs: process.identity.startTimeMs, signal: signalName }) as { signaled?: boolean; message?: unknown } | null;
        if (result?.signaled === true) return;
        const message = (result?.message as { _tag?: string; value?: unknown } | undefined);
        const text = message?._tag === "Some" && typeof message.value === "string" ? message.value : `Failed to send ${signalName} to process ${process.identity.pid}.`;
        deps.toast({ type: "error", title: `Could not send ${signalName}`, description: text });
      } catch (cause) {
        deps.toast({ type: "error", title: `Could not send ${signalName}`, description: errorText(cause, `Failed to send ${signalName}.`) });
      }
    } finally {
      clear();
    }
  }

  async function retryCollector() {
    if (!canMaintain || retrying()) return;
    retrying.set(true);
    try {
      const result = parseTelemetryRetryResult(await deps.request("server.retryResourceTelemetry", {}));
      snapshot.set(result.snapshot);
      streamError.set(null);
      void refreshHistory();
    } catch (cause) {
      deps.toast({ type: "error", title: "Could not restart resource monitor", description: errorText(cause, "The resource monitor retry failed.") });
    } finally {
      retrying.set(false);
    }
  }

  const all = () => snapshot()?.groups.allT3 ?? null;
  const speedLimit = () => snapshot()?.speedLimitPercent ?? null;
  const needsRetry = () => shouldShowResourceMonitorRetry({ nativeStatus: snapshot()?.health.native.status ?? null, error: streamError() });
  const power = () => snapshot()?.power ?? null;
  const hasHostPowerSignal = () => {
    const p = power();
    return p !== null && (p.onBattery !== "unknown" || p.lowPowerMode !== "unknown" || p.idle !== "unknown" || p.locked !== "unknown" || p.thermalState !== "unknown");
  };
  const attributionWidths = columnWidths(ATTRIBUTION_TOTAL, ATTRIBUTION_COLUMNS);
  const dots = (value: string | undefined) => value ?? "...";

  return (
    <View class="gap-10" testID="Resource telemetry">
      <IconSection
        title="Resource monitor"
        icon="activity"
        headerAction={
          <View class="flex-row items-center gap-2">
            {snapshot() ? <SourceStatusBadge label="Native" status={snapshot()!.health.native.status} /> : null}
            <RelativeLabel at={() => snapshot()?.readAt ?? null} prefix="Updated" missing="Waiting for sample" />
            <RefreshAction label="Refresh resource telemetry" tooltip="Refresh telemetry snapshot" pending={streamPending()} onPress={startStream} />
          </View>
        }
      >
        <View class="gap-3 border-b border-border-60 px-5 py-4" style={{ backgroundColor: tokenAlpha("muted", 0.3) }}>
          <View class="flex-row items-center justify-between gap-4">
            <View class="min-w-0 flex-1">
              <Text class="text-3xs font-semibold uppercase tracking-widest" style={{ color: mutedAlpha(0.7) }}>T3 system footprint</Text>
              <Text class="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">Live native counters for the server, providers, terminals, desktop processes, and the monitor itself.</Text>
            </View>
            <View class="flex-row items-center gap-2">
              <View class="size-1.5 rounded-full bg-success" />
              <Text class="text-3xs" style={{ color: mutedAlpha(0.65) }}>{`Sampling every ${snapshot() ? formatSampleInterval(snapshot()!.sampleIntervalMs) : "..."}`}</Text>
            </View>
          </View>
        </View>
        <View class="flex-row">
          <IconStat icon="cpu" label="Current CPU" value={all() ? `${all()!.currentCpuPercent.toFixed(1)}%` : "..."} detail={all() ? `${formatCpuTimeMs(all()!.cpuTimeMs)} observed CPU time` : undefined} />
          <View class="w-px bg-border-50" />
          <IconStat icon="memory-stick" label="Resident memory" value={all() ? formatBytes(all()!.currentRssBytes) : "..."} detail={all() ? `${formatBytes(all()!.peakRssBytes)} combined process peaks` : undefined} />
          <View class="w-px bg-border-50" />
          <IconStat icon="activity" label="Process count" value={all() ? String(all()!.processCount) : "..."} detail={all() ? `${all()!.processStarts} starts · ${all()!.processExits} exits` : undefined} />
        </View>
        <Divider />
        <View class="flex-row">
          <IconStat icon="hard-drive" label="Read throughput" value={all() ? formatRate(all()!.ioReadBytesPerSecond) : "..."} detail={all() ? `${formatBytes(all()!.ioReadBytes)} observed` : undefined} />
          <View class="w-px bg-border-50" />
          <IconStat
            icon="database" label="Write throughput" value={all() ? formatRate(all()!.ioWriteBytesPerSecond) : "..."} detail={all() ? `${formatBytes(all()!.ioWriteBytes)} observed` : undefined}
            tone={all() && all()!.ioWriteBytesPerSecond >= 10 * 1_024 * 1_024 ? "danger" : all() && all()!.ioWriteBytesPerSecond >= 1_024 * 1_024 ? "warning" : "default"}
          />
          <View class="w-px bg-border-50" />
          <IconStat
            icon="gauge" label="CPU speed limit" value={snapshot() ? (speedLimit() === null ? "Unknown" : `${speedLimit()!.toFixed(0)}%`) : "..."}
            detail={snapshot() ? `${snapshot()!.power.thermalState} thermal state` : undefined} tone={speedLimit() !== null && speedLimit()! < 80 ? "warning" : "default"}
          />
        </View>
        {streamError() ? (
          <View class="border-t px-5 py-3" style={{ borderColor: tokenAlpha("destructive", 0.2), backgroundColor: tokenAlpha("destructive", 0.05) }}><ErrorLine message={streamError()!} /></View>
        ) : null}
        {snapshot() ? (
          <View class="flex-row border-t border-border-60" style={{ backgroundColor: tokenAlpha("muted", 0.1) }}>
            <AggregateCard label="Backend + agents" accent={tokenAlpha("success", 0.8)} aggregate={snapshot()!.groups.backend} first />
            <AggregateCard label="Desktop" accent={tokenAlpha("info", 0.8)} aggregate={snapshot()!.groups.electron} />
            <AggregateCard label="Monitor overhead" accent={tokenAlpha("warning", 0.8)} aggregate={snapshot()!.groups.monitor} />
          </View>
        ) : null}
      </IconSection>

      <IconSection
        title="Host & collection"
        icon="gauge"
        headerAction={needsRetry() ? (
          <View
            role="button" accessibilityLabel="Retry monitor" disabled={retrying()} onPress={() => void retryCollector()}
            class={`h-6 flex-row items-center gap-1.5 rounded-lg border border-input bg-background px-2 hover:bg-accent ${retrying() ? "opacity-50" : ""}`}
          >
            <DiagnosticsIcon name="refresh-cw" size={12} tint={token("foreground")} />
            <Text class="text-xs font-medium text-foreground">Retry monitor</Text>
          </View>
        ) : null}
      >
        <View class="flex-row">
          <View class="min-w-0 flex-1 px-5 py-4">
            <PanelTitle icon="battery" title="Host state" />
            {hasHostPowerSignal() && power() ? (
              <>
                <DetailRow first label="Power source" value={booleanStateLabel(power()!.onBattery, { true: "Battery", false: "External power" })} />
                <DetailRow label="Low power mode" value={booleanStateLabel(power()!.lowPowerMode, { true: "Enabled", false: "Disabled" })} />
                <DetailRow label="Idle" value={`${booleanStateLabel(power()!.idle, { true: "Idle", false: "Active" })}${power()!.idleSeconds === null ? "" : ` · ${Math.round(power()!.idleSeconds!)}s`}`} />
                <DetailRow label="Session" value={power()!.suspended ? "Suspended" : booleanStateLabel(power()!.locked, { true: "Locked", false: "Unlocked" })} />
                <DetailRow label="Thermal" value={power()!.thermalState} tone={power()!.thermalState === "serious" || power()!.thermalState === "critical" ? "destructive" : undefined} />
              </>
            ) : (
              <View class="rounded-xl border border-dashed border-border-60 px-4 py-5" style={{ backgroundColor: tokenAlpha("muted", 0.2) }}>
                <Text class="text-sm font-medium text-foreground">Desktop host signals not connected</Text>
                <Text class="mt-1.5 max-w-sm text-2xs leading-relaxed" style={{ color: mutedAlpha(0.7) }}>Power, idle, lock, and thermal state are supplied by the desktop host. Process telemetry remains fully active in this browser session.</Text>
              </View>
            )}
          </View>
          <View class="w-px bg-border-60" />
          <View class="min-w-0 flex-1 px-5 py-4">
            <PanelTitle icon="gauge" title="Collection health" />
            {snapshot() ? (
              <>
                <HealthSource first label="Native process monitor" health={snapshot()!.health.native} />
                <HealthSource label="NSH host (GPUI)" health={snapshot()!.health.desktop} />
                <DetailRow label="Collection time" value={formatDurationMicros(snapshot()!.health.collectionDurationMicros)} />
                <DetailRow label="Process scan" value={`${snapshot()!.health.retainedProcessCount}/${snapshot()!.health.scannedProcessCount} retained`} />
                <DetailRow label="Inaccessible" value={String(snapshot()!.health.inaccessibleProcessCount)} tone={snapshot()!.health.inaccessibleProcessCount > 0 ? "warning" : undefined} />
                <DetailRow label="Sidecar" value={snapshot()!.health.sidecarVersion === null ? "Unavailable" : `${snapshot()!.health.sidecarVersion}${snapshot()!.health.sidecarPid === null ? "" : ` · PID ${snapshot()!.health.sidecarPid}`}`} />
                <DetailRow label="Restarts" value={String(snapshot()!.health.restartCount)} />
              </>
            ) : <Text class="py-4 text-xs text-muted-foreground">Waiting for collector health.</Text>}
          </View>
        </View>
      </IconSection>

      <IconSection
        title="Resource timeline"
        icon="hard-drive"
        headerAction={
          <View class="flex-row items-center gap-2">
            <WindowSelector label="Resource history period" options={HISTORY_WINDOWS.map((option) => ({ label: option.label, value: option.windowMs }))} selected={windowMs} onSelect={(value) => windowMs.set(value)} />
            <RefreshAction label="Refresh resource history" pending={historyPending()} onPress={() => void refreshHistory()} />
          </View>
        }
      >
        {historyError() ? <View class="border-b px-5 py-3" style={{ borderColor: tokenAlpha("destructive", 0.2), backgroundColor: tokenAlpha("destructive", 0.05) }}><ErrorLine message={historyError()!} /></View> : null}
        <ResourceHistoryChart buckets={() => history()?.buckets ?? []} />
        <HistoryProcessTable processes={() => history()?.topProcesses ?? []} />
      </IconSection>

      <IconSection
        title="Live process tree"
        icon="cpu"
        headerAction={snapshot() ? <Text class="text-3xs" style={{ color: mutedAlpha(0.55) }}>{"Identity: PID + start time"}</Text> : null}
      >
        <ProcessTable processes={() => snapshot()?.processes ?? []} canMaintain={canMaintain} signalingKeys={signalingKeys} onSignal={(process, signalName) => void signalProcess(process, signalName)} />
      </IconSection>

      <IconSection
        title="Instrumented application I/O"
        icon="database"
        headerAction={<Text class="text-3xs" style={{ color: mutedAlpha(0.55) }}>Logical bytes by operation</Text>}
      >
        <View class="px-5 py-3" style={{ backgroundColor: tokenAlpha("muted", 0.15) }}>
          <Text class="text-2xs leading-relaxed text-muted-foreground">Native counters identify which process is reading or writing. These application-level counters identify known T3 operations so process spikes can be correlated with specific persistence and logging paths.</Text>
        </View>
        <View class="border-t border-border-60" testID="Instrumented application I/O">
          <DataTable total={ATTRIBUTION_TOTAL} percents={ATTRIBUTION_COLUMNS} headers={["Component", "Operation", "Logical Read", "Logical Write", "Count", "Time"]} right={[false, false, true, true, true, true]}>
            {(snapshot()?.attribution ?? []).length === 0 ? <EmptyRow label="No instrumented application I/O has been recorded yet." /> : null}
            <Each of={snapshot()?.attribution ?? []} key={(entry) => `${entry.component}:${entry.operation}`}>
              {(entry) => (
                <TableRow widths={attributionWidths}>
                  <Cell width={attributionWidths[0]!} first><Text class="truncate text-xs font-medium text-foreground">{entry().component}</Text></Cell>
                  <Cell width={attributionWidths[1]!}><Text class="truncate text-xs text-muted-foreground">{entry().operation}</Text></Cell>
                  <Cell width={attributionWidths[2]!} right><MonoText tone="info">{formatBytes(entry().logicalReadBytes)}</MonoText></Cell>
                  <Cell width={attributionWidths[3]!} right><MonoText tone="warning">{formatBytes(entry().logicalWriteBytes)}</MonoText></Cell>
                  <Cell width={attributionWidths[4]!} right><MonoText>{String(entry().count)}</MonoText></Cell>
                  <Cell width={attributionWidths[5]!} right><MonoText tone="muted">{`${(entry().durationMs / 1_000).toFixed(2).replace(/\.0+$/, "")}s`}</MonoText></Cell>
                </TableRow>
              )}
            </Each>
          </DataTable>
        </View>
      </IconSection>
    </View>
  );
}
