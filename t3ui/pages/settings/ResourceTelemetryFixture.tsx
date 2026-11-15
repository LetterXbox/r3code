import { mount, signal, Text, View } from "nsh";
import { SettingsPageContainer } from "../../components/SettingsLayout";
import { ResourceTelemetryDiagnostics, type TelemetryDeps } from "./ResourceTelemetry";

const none = { _tag: "None" };
const some = (value: unknown) => ({ _tag: "Some", value });
const iso = "2026-11-11T12:00:00Z";
const agg = (n: number) => ({ processCount: n, currentCpuPercent: 12.5, cpuTimeMs: 90_000, currentRssBytes: 2_097_152, peakRssBytes: 4_194_304, ioReadBytes: 2048, ioWriteBytes: 4096, ioReadBytesPerSecond: 1024, ioWriteBytesPerSecond: 2_097_152, processStarts: 3, processExits: 1 });
const proc = (pid: number, ppid: number, depth: number, name: string, category: string, children: number[]) => ({ identity: { pid, startTimeMs: pid * 10 }, ppid, childPids: children, depth, name, command: `/bin/${name} --x`, status: "S", category, cpuPercent: 1.5, cpuTimeMs: 1000, residentBytes: 1_048_576, peakResidentBytes: 1_048_576, virtualBytes: 0, ioReadBytes: 10, ioWriteBytes: 20, ioReadBytesPerSecond: 0, ioWriteBytesPerSecond: 0, ioSemantics: "storage", runTimeMs: 5, firstSeenAt: iso, lastSeenAt: iso });
const health = (status: string, err: unknown) => ({ status, lastSampleAt: none, lastError: err });
const snapshot = {
  readAt: iso, sampleIntervalMs: 2000,
  processes: [proc(100, 1, 0, "t3-server", "server", [101]), proc(101, 100, 1, "codex", "provider-root", [])],
  groups: { backend: agg(2), electron: agg(0), monitor: agg(1), allT3: agg(3) },
  power: { source: "unknown", idle: "false", idleSeconds: 4, locked: "false", suspended: false, onBattery: "true", lowPowerMode: "false", thermalState: "nominal", stale: false, updatedAt: iso },
  speedLimitPercent: some(70),
  attribution: { readAt: iso, entries: [{ component: "sqlite", operation: "persist", logicalReadBytes: 1024, logicalWriteBytes: 2048, count: 4, durationMs: 1500 }] },
  health: { native: health("degraded", some("sidecar exited")), desktop: health("unavailable", some("not in 'web' mode")), sidecarVersion: some("1.2.3"), sidecarPid: some(55), restartCount: 2, collectionDurationMicros: 1500, scannedProcessCount: 40, retainedProcessCount: 3, inaccessibleProcessCount: 2 },
};
const history = { readAt: iso, windowMs: 900000, bucketMs: 30000, sampleIntervalMs: 2000, retainedSampleCount: 5, health: snapshot.health,
  buckets: [{ startedAt: iso, endedAt: iso, avgCpuPercent: 10, maxCpuPercent: 20, maxRssBytes: 1, ioReadBytes: 100, ioWriteBytes: 200, maxProcessCount: 2 }],
  topProcesses: [{ identity: { pid: 101, startTimeMs: 1010 }, ppid: 100, depth: 1, name: "codex", command: "/bin/codex", category: "provider-root", firstSeenAt: iso, lastSeenAt: iso, currentCpuPercent: 1, avgCpuPercent: 1, maxCpuPercent: 9.5, cpuTimeMs: 61_000, currentRssBytes: 1, peakRssBytes: 3_145_728, ioReadBytes: 1, ioWriteBytes: 1, ioSemantics: "storage", sampleCount: 7 }] };

const calls = signal<string[]>([]);
const killOk = signal(true);
const deps: TelemetryDeps = {
  request: async (method, payload) => {
    const p = payload as { pid?: number; signal?: string };
    calls.update((all) => [...all, method === "server.signalProcess" ? `${method} ${p.pid} ${p.signal}` : method]);
    if (method === "server.getResourceTelemetryHistory") return history;
    if (method === "server.retryResourceTelemetry") return { accepted: true, snapshot: { ...snapshot, health: { ...snapshot.health, native: health("healthy", none) } } };
    return { pid: p.pid, signaled: true, message: none };
  },
  subscribe: (method, _payload, onValue) => { calls.update((all) => [...all, method]); setTimeout(() => onValue(snapshot), 0); return () => undefined; },
  confirm: async (message) => { calls.update((all) => [...all, `confirm ${message}`]); return killOk(); },
  toast: (t) => calls.update((all) => [...all, `toast ${t.title}`]),
};
mount(() => (
  <View class="flex-1">
    <View accessibilityLabel="Deny kill" onPress={() => killOk.set(false)}><Text>Deny kill</Text></View>
    <Each of={calls()} key={(call, i) => `${i}${call}`}>{(call) => <Text>{call()}</Text>}</Each>
    <SettingsPageContainer><ResourceTelemetryDiagnostics deps={deps} active environmentKey="e" /></SettingsPageContainer>
  </View>
));
