// The wire shape is defined by packages/contracts/src/server.ts in T3 Code.
// Validate it at the RPC boundary: a malformed response is not an empty result.
type ObjectValue = Record<string, unknown>;

function isObject(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): ObjectValue {
  if (!isObject(value)) throw new Error("Invalid diagnostics response.");
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Invalid diagnostics response.");
  return value;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid diagnostics response.");
  return value;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid diagnostics response.");
  return value;
}

// Effect Schema encodes Option as {_tag: "None"} or {_tag: "Some", value}.
function option(value: unknown): unknown | null {
  const tagged = object(value);
  if (tagged._tag === "None") return null;
  if (tagged._tag === "Some" && "value" in tagged) return tagged.value;
  throw new Error("Invalid diagnostics response.");
}

function errorMessage(value: unknown): string | null {
  const error = option(value);
  return error === null ? null : string(object(error).message);
}

export interface ProcessRow {
  pid: number; ppid: number; command: string; status: string; elapsed: string;
  cpuPercent: number; rssBytes: number; depth: number;
  /** The start time the server checks before it signals a pid, so a recycled pid is never hit. */
  startTimeMs: number;
}
export interface ProcessDiagnostics {
  serverPid: number; readAt: string; processCount: number; totalRssBytes: number;
  totalCpuPercent: number; processes: ProcessRow[]; error: string | null;
}

export function parseProcessDiagnostics(value: unknown): ProcessDiagnostics {
  const data = object(value);
  return {
    serverPid: number(data.serverPid), readAt: string(data.readAt), processCount: number(data.processCount),
    totalRssBytes: number(data.totalRssBytes), totalCpuPercent: number(data.totalCpuPercent),
    error: errorMessage(data.error),
    processes: array(data.processes).map((entry) => {
      const row = object(entry);
      return { pid: number(row.pid), ppid: number(row.ppid), command: string(row.command), status: string(row.status),
        elapsed: string(row.elapsed), cpuPercent: number(row.cpuPercent), rssBytes: number(row.rssBytes), depth: number(row.depth), startTimeMs: number(row.startTimeMs) };
    }),
  };
}

export interface TraceFailure { key: string; name: string; cause: string; durationMs: number; endedAt: string }
export interface TraceGroup { key: string; name: string; cause: string; count: number; lastSeenAt: string }
export interface TraceSpan { key: string; name: string; durationMs: number; endedAt: string; traceId: string }
export interface TraceLog { key: string; spanName: string; level: string; message: string; seenAt: string }
export interface TraceName { key: string; name: string; count: number; failureCount: number; averageDurationMs: number; maxDurationMs: number }
export interface TraceDiagnostics {
  readAt: string; recordCount: number; failureCount: number; slowSpanCount: number; slowSpanThresholdMs: number | null; parseErrorCount: number;
  error: string | null; partialFailure: boolean; latestFailures: TraceFailure[]; commonFailures: TraceGroup[];
  slowestSpans: TraceSpan[]; latestWarningAndErrorLogs: TraceLog[]; topSpansByCount: TraceName[];
}

export function parseTraceDiagnostics(value: unknown): TraceDiagnostics {
  const data = object(value);
  const partial = option(data.partialFailure);
  if (partial !== null && typeof partial !== "boolean") throw new Error("Invalid diagnostics response.");
  return {
    readAt: string(data.readAt), recordCount: number(data.recordCount), failureCount: number(data.failureCount),
    slowSpanCount: number(data.slowSpanCount), slowSpanThresholdMs: typeof data.slowSpanThresholdMs === "number" ? data.slowSpanThresholdMs : null, parseErrorCount: number(data.parseErrorCount),
    error: errorMessage(data.error), partialFailure: partial === true,
    latestFailures: array(data.latestFailures).map((entry, index) => { const row = object(entry); return { key: String(index), name: string(row.name), cause: string(row.cause), durationMs: number(row.durationMs), endedAt: string(row.endedAt) }; }),
    commonFailures: array(data.commonFailures).map((entry, index) => { const row = object(entry); return { key: String(index), name: string(row.name), cause: string(row.cause), count: number(row.count), lastSeenAt: string(row.lastSeenAt) }; }),
    slowestSpans: array(data.slowestSpans).map((entry, index) => { const row = object(entry); return { key: String(index), name: string(row.name), durationMs: number(row.durationMs), endedAt: string(row.endedAt), traceId: string(row.traceId) }; }),
    latestWarningAndErrorLogs: array(data.latestWarningAndErrorLogs).map((entry, index) => { const row = object(entry); return { key: String(index), spanName: string(row.spanName), level: string(row.level), message: string(row.message), seenAt: string(row.seenAt) }; }),
    topSpansByCount: array(data.topSpansByCount).map((entry, index) => { const row = object(entry); return { key: String(index), name: string(row.name), count: number(row.count), failureCount: number(row.failureCount), averageDurationMs: number(row.averageDurationMs), maxDurationMs: number(row.maxDurationMs) }; }),
  };
}

export interface HistoryProcess { key: string; pid: number; command: string; avgCpuPercent: number; maxRssBytes: number; sampleCount: number; currentCpuPercent: number; maxCpuPercent: number; cpuSecondsApprox: number; depth: number; isServerRoot: boolean }
export interface ResourceHistory {
  readAt: string; totalCpuSecondsApprox: number; retainedSampleCount: number; sampleIntervalMs: number;
  topProcesses: HistoryProcess[]; error: string | null;
}

/** A field an older server may not send: 0 when absent. */
const optionalNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function parseResourceHistory(value: unknown): ResourceHistory {
  const data = object(value);
  return { readAt: string(data.readAt), totalCpuSecondsApprox: number(data.totalCpuSecondsApprox),
    retainedSampleCount: number(data.retainedSampleCount), sampleIntervalMs: number(data.sampleIntervalMs), error: errorMessage(data.error),
    topProcesses: array(data.topProcesses).map((entry) => { const row = object(entry); return { key: string(row.processKey), pid: number(row.pid), command: string(row.command), avgCpuPercent: number(row.avgCpuPercent), maxRssBytes: number(row.maxRssBytes), sampleCount: number(row.sampleCount), currentCpuPercent: optionalNumber(row.currentCpuPercent), maxCpuPercent: optionalNumber(row.maxCpuPercent), cpuSecondsApprox: optionalNumber(row.cpuSecondsApprox), depth: optionalNumber(row.depth), isServerRoot: row.isServerRoot === true }; }),
  };
}
