// The logic of TelemetryExportSettings.tsx: the three OTLP signals, what overrides one, and the status line a
// checked endpoint gets.
type Dict = Record<string, unknown>;

export const SIGNALS = [
  { key: "otlpTracesUrl", sourceKey: "otlpTracesSource", variableKey: "otlpTracesVariable", label: "Traces", signal: "traces" },
  { key: "otlpMetricsUrl", sourceKey: "otlpMetricsSource", variableKey: "otlpMetricsVariable", label: "Metrics", signal: "metrics" },
  { key: "otlpLogsUrl", sourceKey: "otlpLogsSource", variableKey: "otlpLogsVariable", label: "Logs", signal: "logs" },
] as const;
export type SignalDescriptor = (typeof SIGNALS)[number];
export type SignalKey = SignalDescriptor["key"];

export type OtlpEndpointCheckResult = { _tag: "Accepted"; latencyMs: number } | { _tag: "Rejected"; status: number } | { _tag: "Unreachable"; timedOut: boolean };
export interface EndpointCheck { url: string; result: OtlpEndpointCheckResult | null }

const OVERRIDE_LABELS = { environment: "Set by environment", bootstrap: "Set by desktop" } as const;

/** An endpoint the environment or the desktop app sets wins over the saved one and cannot be edited here. */
export function runningOverride(running: Dict | null, { key, sourceKey, variableKey }: SignalDescriptor): { url: string; label: string; variable?: string } | undefined {
  const url = running?.[key];
  const source = running?.[sourceKey];
  if (typeof url !== "string" || (source !== "environment" && source !== "bootstrap")) return undefined;
  return { url, label: OVERRIDE_LABELS[source], ...(typeof running?.[variableKey] === "string" ? { variable: running[variableKey] as string } : {}) };
}

export const isHttpUrl = (url: string) => /^https?:\/\/./i.test(url);

export function endpointStatus(url: string, check: EndpointCheck | undefined): { label: string; dot: string } {
  if (url === "") return { label: "Off", dot: "bg-muted-foreground" };
  if (check?.url !== url) return { label: "Not checked", dot: "bg-muted-foreground" };
  const { result } = check;
  if (result === null) return { label: "Checking…", dot: "bg-warning" };
  if (result._tag === "Accepted") return { label: `Connected · ${Math.round(result.latencyMs)} ms`, dot: "bg-success" };
  if (result._tag === "Rejected") return { label: `Rejected · HTTP ${result.status}`, dot: "bg-destructive" };
  return { label: result.timedOut ? "Timed out" : "Unreachable", dot: "bg-destructive" };
}
