// The pure half of the resource telemetry diagnostics, ported from ResourceTelemetryDiagnostics.logic.ts and the
// formatters at the top of ResourceTelemetryDiagnostics.tsx / lib/formatBytes.ts: process-tree collapsing, the retry
// rule, chart bar heights, and every label the sections print.
import type { TelemetryProcess, TelemetryProcessCategory, TelemetrySourceStatus, TelemetryIoSemantics } from "./resourceTelemetryData";

export const processIdentityKey = (process: Pick<TelemetryProcess, "identity">) => `${process.identity.pid}:${process.identity.startTimeMs}`;

/** The rows left after collapsed processes hide their descendants. */
export function visibleResourceTelemetryProcesses(processes: readonly TelemetryProcess[], collapsed: ReadonlySet<string>): TelemetryProcess[] {
  const childrenByParent = new Map<number, TelemetryProcess[]>();
  for (const process of processes) {
    const children = childrenByParent.get(process.ppid) ?? [];
    children.push(process);
    childrenByParent.set(process.ppid, children);
  }
  const hidden = new Set<string>();
  const hideDescendants = (pid: number): void => {
    for (const child of childrenByParent.get(pid) ?? []) {
      const key = processIdentityKey(child);
      if (hidden.has(key)) continue;
      hidden.add(key);
      hideDescendants(child.identity.pid);
    }
  };
  for (const process of processes) if (collapsed.has(processIdentityKey(process))) hideDescendants(process.identity.pid);
  return processes.filter((process) => !hidden.has(processIdentityKey(process)));
}

/** The monitor can be restarted when its native source is not healthy, or when nothing has been read yet and the read failed. */
export function shouldShowResourceMonitorRetry(input: { nativeStatus: TelemetrySourceStatus | null; error: string | null }): boolean {
  return (
    (input.nativeStatus === null && input.error !== null) ||
    input.nativeStatus === "degraded" || input.nativeStatus === "unavailable" || input.nativeStatus === "stopped"
  );
}

export function resourceHistoryBarHeight(input: { value: number; max: number; minimumVisiblePercent: number }): number {
  if (input.value <= 0) return 0;
  return Math.max(input.minimumVisiblePercent, (input.value / Math.max(1, input.max)) * 100);
}

export const resourceHistoryCpuScaleMax = (buckets: readonly { avgCpuPercent: number }[]) => Math.max(1, ...buckets.map((bucket) => bucket.avgCpuPercent));

function formatScaled(value: number): string {
  return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2);
}

/** lib/formatBytes.ts */
export function formatBytes(value: number): string {
  if (Math.round(value) < 1_024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let next = value / 1_024;
  let unitIndex = 0;
  // The unit is chosen after rounding, so 1023.6 KB reads "1.00 MB", not "1024 KB".
  while (Number(formatScaled(next)) >= 1_024 && unitIndex < units.length - 1) {
    next /= 1_024;
    unitIndex += 1;
  }
  return `${formatScaled(next)} ${units[unitIndex]}`;
}

export const formatRate = (value: number) => `${formatBytes(value)}/s`;

const trimZeros = (text: string) => text.replace(/\.0+$/, "");

export function formatCpuTimeMs(valueMs: number): string {
  const seconds = valueMs / 1_000;
  if (seconds < 60) return `${trimZeros(seconds.toFixed(seconds >= 10 ? 1 : 2))}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${trimZeros(minutes.toFixed(minutes >= 10 ? 1 : 2))}m`;
  return `${trimZeros((minutes / 60).toFixed(2))}h`;
}

/** DiagnosticsSettings.tsx formatCpuTime: the same, from seconds. */
export const formatCpuTimeSeconds = (seconds: number) => formatCpuTimeMs(seconds * 1_000);

export function formatDurationMicros(value: number): string {
  if (value < 1_000) return `${Math.round(value)} µs`;
  if (value < 1_000_000) return `${trimZeros((value / 1_000).toFixed(2))} ms`;
  return `${trimZeros((value / 1_000_000).toFixed(2))} s`;
}

export function formatSampleInterval(valueMs: number): string {
  if (valueMs < 1_000) return `${Math.max(0, Math.round(valueMs))} ms`;
  const seconds = valueMs / 1_000;
  return `${(Math.round(seconds * 10) / 10).toLocaleString()} ${seconds === 1 ? "second" : "seconds"}`;
}

/** DiagnosticsSettings.tsx formatDuration. */
export function formatDurationMs(value: number): string {
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${trimZeros((value / 1_000).toFixed(value >= 10_000 ? 1 : 2))} s`;
}

export const formatCount = (value: number) => value.toLocaleString("en-US");

export function formatProcessName(process: { command: string; name: string }): string {
  if (process.name.trim()) return process.name;
  const firstToken = process.command.trim().split(/\s+/)[0] ?? process.command;
  const normalized = firstToken.replace(/^['"]|['"]$/g, "");
  const segments = normalized.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? normalized;
}

export function categoryLabel(category: TelemetryProcessCategory): string {
  switch (category) {
    case "server": return "Server";
    case "server-child": return "Backend child";
    case "provider-root": return "Provider";
    case "terminal-root": return "Terminal";
    // Wire category names stay "electron-*" (shared with the server contract, see resourceTelemetryData.ts); this
    // app has no Electron, so the UI relabels them to what each process actually is here (see the parity audit):
    // the NSH/GPUI host process itself, its WebView-hosted preview content, its GPU process, and any other helper.
    case "electron-main": return "NSH host (GPUI)";
    case "electron-renderer": return "WebView content";
    case "electron-gpu": return "GPU";
    case "electron-utility": return "Helper";
    case "resource-monitor": return "Monitor";
    case "unknown-t3": return "T3 process";
  }
}

/** The token that colours a category's dot. */
export function categoryDotToken(category: TelemetryProcessCategory): "warning" | "info" | "violet" | "success" {
  if (category === "resource-monitor") return "warning";
  if (category.startsWith("electron-")) return "info";
  if (category === "server") return "violet";
  return "success";
}

export function ioSemanticsLabel(semantics: TelemetryIoSemantics): string {
  switch (semantics) {
    case "storage": return "Storage bytes";
    case "logical": return "Logical bytes";
    case "all-io": return "All I/O bytes";
    case "unavailable": return "Unavailable";
  }
}

export function booleanStateLabel(value: "true" | "false" | "unknown", labels: { true: string; false: string }): string {
  if (value === "true") return labels.true;
  if (value === "false") return labels.false;
  return "Unknown";
}

export type SourceTone = "default" | "warning" | "danger";
export function sourceStatusTone(status: TelemetrySourceStatus): SourceTone {
  if (status === "healthy") return "default";
  if (status === "starting" || status === "degraded") return "warning";
  return "danger";
}

/** Only a backend child, a provider or a terminal can be signalled. */
export const canSignalProcess = (process: Pick<TelemetryProcess, "category">) =>
  process.category === "server-child" || process.category === "provider-root" || process.category === "terminal-root";

/** `Updated 5m ago` / `Checked just now`: the web's relative time (formatRelativeElapsed). */
export function relativeParts(iso: string, nowMs: number): { value: string; suffix: string | null } | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.floor(Math.max(0, nowMs - then) / 1000);
  if (seconds < 60) return { value: "just now", suffix: null };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { value: `${minutes}m`, suffix: "ago" };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: `${hours}h`, suffix: "ago" };
  return { value: `${Math.floor(hours / 24)}d`, suffix: "ago" };
}

/** The trace id a table cell shows (DiagnosticsSettings.tsx shortenTraceId). */
export function shortenTraceId(traceId: string): string {
  if (traceId.length <= 32) return traceId;
  return `${traceId.slice(0, 18)}...${traceId.slice(-10)}`;
}
