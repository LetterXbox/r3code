import { mount, signal, Text, View } from "nsh";
import { ToastHost } from "../../components/toast";
import { DiagnosticsView } from "./Diagnostics";
import type { BackendStatus } from "../../store";

const status = signal<BackendStatus>("disconnected");
const active = signal(true);
const calls = signal<string[]>([]);
const scenario = signal("normal");
const pending: { method: string; resolve: (value: unknown) => void; reject: (cause: unknown) => void }[] = [];
const none = { _tag: "None" };
const some = (value: unknown) => ({ _tag: "Some", value });
const now = "2026-11-11T12:00:00Z";

function result(method: string): unknown {
  if (method === "server.signalProcess") {
    if (scenario() === "signal-exited") return { pid: 456, signal: "SIGINT", signaled: false, message: some("Process 456 is not a live descendant of the T3 server.") };
    if (scenario() === "signal-refused") return { pid: 456, signal: "SIGINT", signaled: false, message: some("Operation not permitted") };
    if (scenario() === "signal-refused-silent") return { pid: 456, signal: "SIGINT", signaled: false, message: none };
    return { pid: 456, signal: "SIGINT", signaled: true, message: none };
  }
  if (method === "server.getProcessDiagnostics") return {
    serverPid: 123, readAt: now, processCount: 1, totalRssBytes: 2097152, totalCpuPercent: 12.5, error: none,
    processes: [{ pid: 456, startTimeMs: 1700, ppid: 123, status: "S", elapsed: "01:00", cpuPercent: 12.5, rssBytes: 2097152, depth: 1, command: "worker --test" }],
  };
  if (method === "server.getTraceDiagnostics") return scenario() === "malformed" ? { recordCount: 12 } : {
    readAt: now, recordCount: 12, failureCount: 1, slowSpanCount: 1, parseErrorCount: 0,
    error: scenario() === "partial" ? some({ message: "One trace file could not be read" }) : none,
    partialFailure: scenario() === "partial" ? some(true) : none,
    latestFailures: [{ name: "request failed", cause: "network unavailable", durationMs: 250, endedAt: now }],
    commonFailures: [{ name: "request failed", cause: "network unavailable", count: 3, lastSeenAt: now }],
    slowestSpans: [{ name: "slow request", durationMs: 1300, endedAt: now, traceId: "trace-123" }],
    latestWarningAndErrorLogs: [{ spanName: "worker", level: "WARN", message: "retry scheduled", seenAt: now }],
    topSpansByCount: [{ name: "service.call", count: 7, failureCount: 1, averageDurationMs: 20, maxDurationMs: 90 }],
  };
  return { readAt: now, totalCpuSecondsApprox: 7.2, retainedSampleCount: 3, sampleIntervalMs: 1000, error: none,
    topProcesses: [{ processKey: "456-start", pid: 456, command: "worker --test", avgCpuPercent: 5, maxRssBytes: 2097152, sampleCount: 3 }] };
}

function request(method: string, payload: unknown): Promise<unknown> {
  let suffix = "";
  if (typeof payload === "object" && payload !== null && "windowMs" in payload && "bucketMs" in payload) suffix = ` ${String(payload.windowMs)}/${String(payload.bucketMs)}`;
  if (typeof payload === "object" && payload !== null && "startTimeMs" in payload) suffix = ` ${String((payload as unknown as { pid: number }).pid)} ${String((payload as unknown as { startTimeMs: number }).startTimeMs)} ${String((payload as unknown as { signal: string }).signal)}`;
  calls.update((items) => [...items, `${method}${suffix}`]);
  return new Promise((resolve, reject) => pending.push({ method, resolve, reject }));
}

function complete(count: number) {
  for (const item of pending.splice(0, count)) {
    if (scenario() === "process-error" && item.method === "server.getProcessDiagnostics") item.reject(new Error("Diagnostics access denied"));
    else item.resolve(result(item.method));
  }
}

mount(() => <View class="flex-1">
  <View accessibilityLabel="Connect fixture" onPress={() => status.set("connected")}><Text>Connect fixture</Text></View>
  <View accessibilityLabel="Disconnect fixture" onPress={() => status.set("disconnected")}><Text>Disconnect fixture</Text></View>
  <View accessibilityLabel="Hide diagnostics fixture" onPress={() => active.set(false)}><Text>Hide diagnostics fixture</Text></View>
  <View accessibilityLabel="Show diagnostics fixture" onPress={() => active.set(true)}><Text>Show diagnostics fixture</Text></View>
  <View accessibilityLabel="Partial trace fixture" onPress={() => scenario.set("partial")}><Text>Partial trace fixture</Text></View>
  <View accessibilityLabel="Malformed trace fixture" onPress={() => scenario.set("malformed")}><Text>Malformed trace fixture</Text></View>
  <View accessibilityLabel="Process error fixture" onPress={() => scenario.set("process-error")}><Text>Process error fixture</Text></View>
  <View accessibilityLabel="Signal exited fixture" onPress={() => scenario.set("signal-exited")}><Text>Signal exited fixture</Text></View>
  <View accessibilityLabel="Signal refused fixture" onPress={() => scenario.set("signal-refused")}><Text>Signal refused fixture</Text></View>
  <View accessibilityLabel="Signal refused silent fixture" onPress={() => scenario.set("signal-refused-silent")}><Text>Signal refused silent fixture</Text></View>
  <View accessibilityLabel="Complete oldest requests" onPress={() => complete(3)}><Text>Complete oldest requests</Text></View>
  <View accessibilityLabel="Complete requests" onPress={() => complete(pending.length)}><Text>Complete requests</Text></View>
  <Text>{`Requests: ${calls().length}`}</Text>
  <Each of={calls()} key={(call) => call}>{(call) => <Text>{call()}</Text>}</Each>
  <ToastHost />
  <DiagnosticsView status={status()} connectionError={null} environmentKey="fixture" active={active()} request={request} onConnect={() => status.set("connected")} />
</View>);
