// The wire shapes of the resource telemetry RPCs, packages/contracts/src/resourceTelemetry.ts: the
// `subscribeResourceTelemetry` stream (ResourceTelemetrySnapshot), `server.getResourceTelemetryHistory`
// (ResourceTelemetryHistory) and `server.retryResourceTelemetry` (ResourceTelemetryRetryResult).
// Validated at the RPC boundary: a malformed answer is an error, never an empty table. Effect encodes
// Option as {_tag: "None"} or {_tag: "Some", value}, and DateTimeUtc as an ISO string.
type Obj = Record<string, unknown>;

const bad = () => new Error("Invalid diagnostics response.");
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
function obj(value: unknown): Obj { if (!isObj(value)) throw bad(); return value; }
function str(value: unknown): string { if (typeof value !== "string") throw bad(); return value; }
function num(value: unknown): number { if (typeof value !== "number" || !Number.isFinite(value)) throw bad(); return value; }
function bool(value: unknown): boolean { if (typeof value !== "boolean") throw bad(); return value; }
function arr(value: unknown): unknown[] { if (!Array.isArray(value)) throw bad(); return value; }
function option(value: unknown): unknown | null {
  const tagged = obj(value);
  if (tagged._tag === "None") return null;
  if (tagged._tag === "Some" && "value" in tagged) return tagged.value;
  throw bad();
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw bad();
  return value as T;
}

export const PROCESS_CATEGORIES = ["server", "server-child", "provider-root", "terminal-root", "electron-main", "electron-renderer", "electron-gpu", "electron-utility", "resource-monitor", "unknown-t3"] as const;
export type TelemetryProcessCategory = (typeof PROCESS_CATEGORIES)[number];
export const IO_SEMANTICS = ["storage", "logical", "all-io", "unavailable"] as const;
export type TelemetryIoSemantics = (typeof IO_SEMANTICS)[number];
export const SOURCE_STATUSES = ["starting", "healthy", "degraded", "unavailable", "stopped"] as const;
export type TelemetrySourceStatus = (typeof SOURCE_STATUSES)[number];
const BOOLEAN_STATES = ["true", "false", "unknown"] as const;
type BooleanState = (typeof BOOLEAN_STATES)[number];
const THERMAL_STATES = ["unknown", "nominal", "fair", "serious", "critical"] as const;

export interface TelemetryProcess {
  identity: { pid: number; startTimeMs: number };
  ppid: number; childPids: number[]; depth: number;
  name: string; command: string; status: string; category: TelemetryProcessCategory;
  cpuPercent: number; cpuTimeMs: number; residentBytes: number;
  ioReadBytes: number; ioWriteBytes: number; ioReadBytesPerSecond: number; ioWriteBytesPerSecond: number;
  ioSemantics: TelemetryIoSemantics;
}

export interface TelemetryAggregate {
  processCount: number; currentCpuPercent: number; cpuTimeMs: number; currentRssBytes: number; peakRssBytes: number;
  ioReadBytes: number; ioWriteBytes: number; ioReadBytesPerSecond: number; ioWriteBytesPerSecond: number;
  processStarts: number; processExits: number;
}

export interface TelemetrySourceHealth { status: TelemetrySourceStatus; lastSampleAt: string | null; lastError: string | null }
export interface TelemetryHealth {
  native: TelemetrySourceHealth; desktop: TelemetrySourceHealth;
  sidecarVersion: string | null; sidecarPid: number | null; restartCount: number;
  collectionDurationMicros: number; scannedProcessCount: number; retainedProcessCount: number; inaccessibleProcessCount: number;
}

export interface TelemetryPower {
  idle: BooleanState; idleSeconds: number | null; locked: BooleanState; suspended: boolean;
  onBattery: BooleanState; lowPowerMode: BooleanState; thermalState: (typeof THERMAL_STATES)[number];
}

export interface TelemetryAttributionEntry { component: string; operation: string; logicalReadBytes: number; logicalWriteBytes: number; count: number; durationMs: number }

export interface TelemetrySnapshot {
  readAt: string; sampleIntervalMs: number; processes: TelemetryProcess[];
  groups: { backend: TelemetryAggregate; electron: TelemetryAggregate; monitor: TelemetryAggregate; allT3: TelemetryAggregate };
  power: TelemetryPower; speedLimitPercent: number | null;
  attribution: TelemetryAttributionEntry[]; health: TelemetryHealth;
}

function aggregate(value: unknown): TelemetryAggregate {
  const data = obj(value);
  return {
    processCount: num(data.processCount), currentCpuPercent: num(data.currentCpuPercent), cpuTimeMs: num(data.cpuTimeMs),
    currentRssBytes: num(data.currentRssBytes), peakRssBytes: num(data.peakRssBytes), ioReadBytes: num(data.ioReadBytes),
    ioWriteBytes: num(data.ioWriteBytes), ioReadBytesPerSecond: num(data.ioReadBytesPerSecond), ioWriteBytesPerSecond: num(data.ioWriteBytesPerSecond),
    processStarts: num(data.processStarts), processExits: num(data.processExits),
  };
}

function sourceHealth(value: unknown): TelemetrySourceHealth {
  const data = obj(value);
  const lastSample = option(data.lastSampleAt);
  const lastError = option(data.lastError);
  return { status: oneOf(data.status, SOURCE_STATUSES), lastSampleAt: lastSample === null ? null : str(lastSample), lastError: lastError === null ? null : str(lastError) };
}

export function parseTelemetryHealth(value: unknown): TelemetryHealth {
  const data = obj(value);
  const version = option(data.sidecarVersion);
  const pid = option(data.sidecarPid);
  return {
    native: sourceHealth(data.native), desktop: sourceHealth(data.desktop),
    sidecarVersion: version === null ? null : str(version), sidecarPid: pid === null ? null : num(pid),
    restartCount: num(data.restartCount), collectionDurationMicros: num(data.collectionDurationMicros),
    scannedProcessCount: num(data.scannedProcessCount), retainedProcessCount: num(data.retainedProcessCount), inaccessibleProcessCount: num(data.inaccessibleProcessCount),
  };
}

function process(value: unknown): TelemetryProcess {
  const data = obj(value);
  const identity = obj(data.identity);
  return {
    identity: { pid: num(identity.pid), startTimeMs: num(identity.startTimeMs) },
    ppid: num(data.ppid), childPids: arr(data.childPids).map(num), depth: num(data.depth),
    name: str(data.name), command: str(data.command), status: str(data.status), category: oneOf(data.category, PROCESS_CATEGORIES),
    cpuPercent: num(data.cpuPercent), cpuTimeMs: num(data.cpuTimeMs), residentBytes: num(data.residentBytes),
    ioReadBytes: num(data.ioReadBytes), ioWriteBytes: num(data.ioWriteBytes),
    ioReadBytesPerSecond: num(data.ioReadBytesPerSecond), ioWriteBytesPerSecond: num(data.ioWriteBytesPerSecond),
    ioSemantics: oneOf(data.ioSemantics, IO_SEMANTICS),
  };
}

export function parseTelemetrySnapshot(value: unknown): TelemetrySnapshot {
  const data = obj(value);
  const groups = obj(data.groups);
  const power = obj(data.power);
  const speed = option(data.speedLimitPercent);
  return {
    readAt: str(data.readAt), sampleIntervalMs: num(data.sampleIntervalMs), processes: arr(data.processes).map(process),
    groups: { backend: aggregate(groups.backend), electron: aggregate(groups.electron), monitor: aggregate(groups.monitor), allT3: aggregate(groups.allT3) },
    power: {
      idle: oneOf(power.idle, BOOLEAN_STATES), idleSeconds: power.idleSeconds === null ? null : num(power.idleSeconds), locked: oneOf(power.locked, BOOLEAN_STATES),
      suspended: bool(power.suspended), onBattery: oneOf(power.onBattery, BOOLEAN_STATES), lowPowerMode: oneOf(power.lowPowerMode, BOOLEAN_STATES),
      thermalState: oneOf(power.thermalState, THERMAL_STATES),
    },
    speedLimitPercent: speed === null ? null : num(speed),
    attribution: arr(obj(data.attribution).entries).map((entry) => {
      const row = obj(entry);
      return { component: str(row.component), operation: str(row.operation), logicalReadBytes: num(row.logicalReadBytes), logicalWriteBytes: num(row.logicalWriteBytes), count: num(row.count), durationMs: num(row.durationMs) };
    }),
    health: parseTelemetryHealth(data.health),
  };
}

export interface TelemetryHistoryBucket { startedAt: string; avgCpuPercent: number; maxCpuPercent: number; ioReadBytes: number; ioWriteBytes: number }
export interface TelemetryProcessSummary {
  identity: { pid: number; startTimeMs: number }; name: string; command: string; category: TelemetryProcessCategory;
  maxCpuPercent: number; cpuTimeMs: number; peakRssBytes: number; ioReadBytes: number; ioWriteBytes: number; sampleCount: number;
}
export interface TelemetryHistory { readAt: string; buckets: TelemetryHistoryBucket[]; topProcesses: TelemetryProcessSummary[] }

export function parseTelemetryHistory(value: unknown): TelemetryHistory {
  const data = obj(value);
  return {
    readAt: str(data.readAt),
    buckets: arr(data.buckets).map((entry) => {
      const row = obj(entry);
      return { startedAt: str(row.startedAt), avgCpuPercent: num(row.avgCpuPercent), maxCpuPercent: num(row.maxCpuPercent), ioReadBytes: num(row.ioReadBytes), ioWriteBytes: num(row.ioWriteBytes) };
    }),
    topProcesses: arr(data.topProcesses).map((entry) => {
      const row = obj(entry);
      const identity = obj(row.identity);
      return {
        identity: { pid: num(identity.pid), startTimeMs: num(identity.startTimeMs) }, name: str(row.name), command: str(row.command), category: oneOf(row.category, PROCESS_CATEGORIES),
        maxCpuPercent: num(row.maxCpuPercent), cpuTimeMs: num(row.cpuTimeMs), peakRssBytes: num(row.peakRssBytes), ioReadBytes: num(row.ioReadBytes), ioWriteBytes: num(row.ioWriteBytes), sampleCount: num(row.sampleCount),
      };
    }),
  };
}

/** ResourceTelemetryRetryResult: the snapshot after the restart. */
export function parseTelemetryRetryResult(value: unknown): { accepted: boolean; snapshot: TelemetrySnapshot } {
  const data = obj(value);
  return { accepted: bool(data.accepted), snapshot: parseTelemetrySnapshot(data.snapshot) };
}
