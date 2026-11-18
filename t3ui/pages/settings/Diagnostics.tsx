import { effect, Scroll, signal, Storage, Text, untracked, View } from "nsh";
import { FadeScroll } from "../../components/FadeScroll";
import { codeTextStyle } from "../../typography";
import { openInEditor } from "../../components/header/gitRuntime";
import { effectiveEditor, readAvailableEditors } from "../../components/header/openInLogic";
import { serverObservability } from "./settingsState";
import { SettingsSection, SettingsSelect } from "../../components/SettingsLayout";
import { confirm, showToast } from "../../components/toast";
import { TelemetryExportSettings } from "./TelemetryExport";
import { ResourceTelemetryDiagnostics, type TelemetryDeps } from "./ResourceTelemetry";
import { IconAction, ErrorLine, TraceIdCell, WindowSelector } from "./DiagnosticsParts";
import { shortenTraceId } from "./resourceTelemetryLogic";
import { backendError, backendStatus, backendUrl, openSettings, requestBackend, settingsOpen, settingsSection, subscribeBackend, type BackendStatus } from "../../store";
import { parseProcessDiagnostics, parseResourceHistory, parseTraceDiagnostics, type HistoryProcess, type ProcessDiagnostics, type ResourceHistory, type TraceDiagnostics } from "./DiagnosticsData";

type LoadState<T> = { kind: "idle" | "loading" } | { kind: "loaded"; data: T } | { kind: "error"; message: string };
type Request = (method: string, payload: unknown) => Promise<unknown>;
const WINDOWS = [
  { value: "5m", label: "5m", windowMs: 300000, bucketMs: 30000 },
  { value: "15m", label: "15m", windowMs: 900000, bucketMs: 60000 },
  { value: "30m", label: "30m", windowMs: 1800000, bucketMs: 120000 },
  { value: "1h", label: "1h", windowMs: 3600000, bucketMs: 300000 },
];

function value<T>(state: LoadState<T>): T | null { return state.kind === "loaded" ? state.data : null; }
function loadError<T>(state: LoadState<T>): string | null { return state.kind === "error" ? state.message : null; }
/** formatEnvironmentQueryError: the error's message, or the generic line when it has none. */
function errorText(cause: unknown): string { return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : "The environment request failed."; }
function bytes(count: number): string {
  if (count < 1024) return `${count} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = count / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return `${amount.toFixed(1)} ${units[unit]}`;
}
function duration(ms: number): string { return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`; }
/** DiagnosticsLastChecked: an unreadable check time reads "Checked unavailable" (DiagnosticsSettings.tsx:660). */
function checked(value: string): string {
  return Number.isNaN(new Date(value).getTime()) ? "Checked unavailable" : `Checked ${time(value)}`;
}
function time(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** formatCpuTime (DiagnosticsSettings.tsx). */
export function formatCpuTime(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2).replace(/\.0+$/, "")}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes >= 10 ? 1 : 2).replace(/\.0+$/, "")}m`;
  return `${(minutes / 60).toFixed(2).replace(/\.0+$/, "")}h`;
}

/** formatShortProcessName: the command's first token's basename, cut at 42 characters. */
export function formatShortProcessName(command: string): string {
  const first = command.trim().split(/\s+/)[0];
  const normalized = first ? first.replace(/^['"]|['"]$/g, "") : command;
  const name = first ? (normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? normalized) : command;
  return name.length > 42 ? `${name.slice(0, 39)}...` : name;
}

const HISTORY_COLUMNS = [
  { title: "Process", basis: "24%", right: false }, { title: "CPU Time", basis: "10%", right: true }, { title: "Current", basis: "10%", right: true },
  { title: "Average", basis: "10%", right: true }, { title: "Peak", basis: "10%", right: true }, { title: "Max Mem", basis: "10%", right: true },
  { title: "Command", basis: "16%", right: false }, { title: "PID", basis: "10%", right: true },
] as const;

/** ProcessResourceHistoryTable: one row per process, children indented under the shallowest child depth. */
function ProcessResourceHistoryTable(props: { processes: readonly HistoryProcess[] }) {
  const shallowest = props.processes.reduce<number | null>((min, row) => (row.isServerRoot ? min : min === null ? row.depth : Math.min(min, row.depth)), null);
  const cell = (index: number) => `${HISTORY_COLUMNS[index]!.right ? "items-end" : ""} min-w-0 px-3 py-2`;
  return (
    <FadeScroll class="max-h-[44rem] border-t border-border-60" horizontal>
      <View style={{ minWidth: 980 }}>
        <View class="flex-row border-b border-border-60 bg-card">
          {HISTORY_COLUMNS.map((column, index) => <View class={cell(index)} style={{ flexBasis: column.basis, flexGrow: 0, flexShrink: 0 }}><Text class="text-2xs font-semibold uppercase tracking-widest text-muted-foreground-70">{column.title}</Text></View>)}
        </View>
        <Each of={[...props.processes]} key={(row) => row.key}>{(row) => {
          const depth = () => (row().isServerRoot || shallowest === null ? 0 : Math.max(1, row().depth - shallowest + 1));
          const values = () => [formatCpuTime(row().cpuSecondsApprox), `${row().currentCpuPercent.toFixed(1)}%`, `${row().avgCpuPercent.toFixed(1)}%`, `${row().maxCpuPercent.toFixed(1)}%`, bytes(row().maxRssBytes)];
          return (
            <View class="flex-row items-center border-b border-border-50 hover:bg-accent-50">
              <View class={cell(0)} style={{ flexBasis: "24%", flexGrow: 0, flexShrink: 0, paddingLeft: 16 + Math.min(depth(), 6) * 10 }} accessibilityLabel={`${row().isServerRoot ? "Root" : "Child"} process ${formatShortProcessName(row().command)}`}>
                <View class="flex-row items-center gap-2">
                  <View class={`size-1.5 rounded-full ${row().isServerRoot ? "bg-warning" : "bg-success"}`} />
                  <Text class="truncate text-xs font-medium text-foreground">{formatShortProcessName(row().command)}</Text>
                </View>
              </View>
              {values().map((text, index) => <View class={cell(index + 1)} style={{ flexBasis: "10%", flexGrow: 0, flexShrink: 0 }}><Text class="text-xs text-foreground" style={codeTextStyle()}>{text}</Text></View>)}
              <View class={cell(6)} style={{ flexBasis: "16%", flexGrow: 0, flexShrink: 0 }} tooltip={row().command}><Text class="truncate text-xs text-muted-foreground">{row().command}</Text></View>
              <View class={cell(7)} style={{ flexBasis: "10%", flexGrow: 0, flexShrink: 0 }}><Text class="text-xs text-muted-foreground" style={codeTextStyle()}>{String(row().pid)}</Text></View>
            </View>
          );
        }}</Each>
      </View>
    </FadeScroll>
  );
}

function Stat(props: { label: string; amount: string; tooltip?: string }) {
  return <View class="min-w-0 flex-1 gap-1" tooltip={props.tooltip}><Text class="text-xs text-muted-foreground">{props.label}</Text><Text class="text-base font-medium text-foreground">{props.amount}</Text></View>;
}

function Refresh(props: { label: string; loading: boolean; onPress: () => void }) {
  return <View accessibilityLabel={props.label} disabled={props.loading} onPress={props.onPress} class="rounded-md border border-border px-2 py-1 hover:bg-accent"><Text class="text-xs text-foreground">{props.loading ? "Refreshing..." : "Refresh"}</Text></View>;
}

function StateMessage(props: { loading: boolean; error: string | null; /** The section's own empty label while it first loads (DiagnosticsSettings.tsx). */ loadingLabel?: string }) {
  return <>{props.loading ? <Text class="px-4 py-3 text-sm text-muted-foreground">{props.loadingLabel ?? "Loading..."}</Text> : null}{props.error ? <Text class="px-4 py-3 text-sm text-destructive">{props.error}</Text> : null}</>;
}

export function DiagnosticsView(props: {
  status: BackendStatus;
  connectionError: string | null;
  environmentKey: string;
  active: boolean;
  request: Request;
  onConnect: () => void;
  /** The resource telemetry sections' transport; absent in fixtures that only exercise the older sections. */
  telemetry?: TelemetryDeps;
  /** `observability.logsDirectoryPath` of the connected server, and the action that opens it in the editor. */
  logsDirectoryPath?: string | null;
  openLogsFolder?: (path: string) => Promise<void>;
}) {
  const openingLogs = signal(false);
  const logsError = signal<string | null>(null);
  async function openLogs() {
    const path = props.logsDirectoryPath;
    if (!path || !props.openLogsFolder || openingLogs()) return;
    openingLogs.set(true);
    logsError.set(null);
    try { await props.openLogsFolder(path); } catch (cause) { logsError.set(cause instanceof Error && cause.message ? cause.message : "Unable to open logs folder."); }
    openingLogs.set(false);
  }
  const processes = signal<LoadState<ProcessDiagnostics>>({ kind: "idle" });
  const trace = signal<LoadState<TraceDiagnostics>>({ kind: "idle" });
  const history = signal<LoadState<ResourceHistory>>({ kind: "idle" });
  const historyWindow = signal("15m");
  const signalingPid = signal<number | null>(null);
  let processRequest = 0;
  let traceRequest = 0;
  let historyRequest = 0;

  async function refreshProcesses() {
    const current = ++processRequest;
    processes.set({ kind: "loading" });
    try {
      const result = parseProcessDiagnostics(await props.request("server.getProcessDiagnostics", {}));
      if (current === processRequest && props.status === "connected") processes.set({ kind: "loaded", data: result });
    } catch (cause) { if (current === processRequest && props.status === "connected") processes.set({ kind: "error", message: errorText(cause) }); }
  }
  async function refreshTrace() {
    const current = ++traceRequest;
    trace.set({ kind: "loading" });
    try {
      const result = parseTraceDiagnostics(await props.request("server.getTraceDiagnostics", {}));
      if (current === traceRequest && props.status === "connected") trace.set({ kind: "loaded", data: result });
    } catch (cause) { if (current === traceRequest && props.status === "connected") trace.set({ kind: "error", message: errorText(cause) }); }
  }
  async function refreshHistory(window: string) {
    const selected = WINDOWS.find((item) => item.value === window);
    if (!selected) return;
    const current = ++historyRequest;
    history.set({ kind: "loading" });
    try {
      const result = parseResourceHistory(await props.request("server.getProcessResourceHistory", { windowMs: selected.windowMs, bucketMs: selected.bucketMs }));
      if (current === historyRequest && props.status === "connected") history.set({ kind: "loaded", data: result });
    } catch (cause) { if (current === historyRequest && props.status === "connected") history.set({ kind: "error", message: errorText(cause) }); }
  }

  /** signalProcess: SIGKILL asks first; the server rejects a pid whose start time changed, so an exited process is never hit. */
  async function signalProcess(row: { pid: number; startTimeMs: number }, signalName: "SIGINT" | "SIGKILL") {
    if (signalingPid() !== null) return;
    signalingPid.set(row.pid);
    try {
      if (signalName === "SIGKILL") {
        let confirmed = false;
        try { confirmed = await confirm(`Send SIGKILL to process ${row.pid}? This cannot be handled by the process.`, { variant: "destructive" }); }
        catch (cause) { showToast({ type: "error", title: "Could not confirm signal", description: cause instanceof Error && cause.message ? cause.message : `Failed to send ${signalName}.` }); return; }
        if (!confirmed) return;
      }
      try {
        const result = await props.request("server.signalProcess", { pid: row.pid, startTimeMs: row.startTimeMs, signal: signalName }) as { signaled?: boolean; message?: unknown } | null;
        if (result?.signaled === false) {
          void refreshProcesses();
          // ServerSignalProcessResult.message is an Option: {_tag: "Some", value} when the server explains the refusal.
          const tagged = result.message as { _tag?: string; value?: unknown } | null | undefined;
          const message = tagged?._tag === "Some" && typeof tagged.value === "string" ? tagged.value : undefined;
          // isStaleProcessSignalMessage: only a "not a live descendant" refusal means the process already exited.
          if (message?.includes("not a live descendant")) {
            showToast({ type: "info", title: "Process already exited", description: "The process is not a child of the T3 Server. It might already have exited." });
            return;
          }
          showToast({ type: "error", title: `Could not send ${signalName}`, description: message ?? `Failed to send ${signalName}.` });
          return;
        }
        void refreshProcesses();
      } catch (cause) {
        showToast({ type: "error", title: `Could not send ${signalName}`, description: cause instanceof Error && cause.message ? cause.message : `Failed to send ${signalName}.` });
      }
    } finally {
      signalingPid.set(null);
    }
  }

  effect(() => {
    const connected = props.active && props.status === "connected";
    void props.environmentKey;
    if (connected) untracked(() => { void refreshProcesses(); void refreshTrace(); });
    else untracked(() => { processes.set({ kind: "idle" }); trace.set({ kind: "idle" }); });
    return () => { processRequest++; traceRequest++; };
  });
  effect(() => {
    const connected = props.active && props.status === "connected";
    void props.environmentKey;
    const window = historyWindow();
    if (connected) untracked(() => void refreshHistory(window));
    else untracked(() => history.set({ kind: "idle" }));
    return () => { historyRequest++; };
  });

  const processData = () => value(processes());
  const traceData = () => value(trace());
  const historyData = () => value(history());
  const traceUsable = () => traceData() !== null && (!traceData()?.error || traceData()?.partialFailure);
  // The tables show their own "Loading ..." label until the first trace read lands (DiagnosticsSettings.tsx:1160-1316).
  const traceInitialLoading = () => traceData() === null && (trace().kind === "loading" || trace().kind === "idle");
  const empty = (rows: readonly unknown[] | undefined) => (rows ?? []).length === 0;

  return <View class="gap-6">
    {props.status !== "connected" ? <View class="items-start gap-3 px-4">
      <Text class="text-sm text-muted-foreground">{props.status === "connecting" ? "Connecting to environment..." : "Connect an environment to see diagnostics."}</Text>
      {props.connectionError ? <Text class="text-xs text-destructive">{props.connectionError}</Text> : null}
      {props.status !== "connecting" ? <View accessibilityLabel="Connect diagnostics environment" onPress={props.onConnect} class="rounded-md border border-border px-3 py-1.5 hover:bg-accent"><Text class="text-xs text-foreground">Connect environment</Text></View> : null}
    </View> : null}
    {props.status === "connected" ? <>
      {props.telemetry ? <ResourceTelemetryDiagnostics deps={props.telemetry} active={props.active} environmentKey={props.environmentKey} /> : null}
      <SettingsSection title="Live Processes">
        <View class="flex-row items-center justify-between px-4 py-3"><Text class="text-xs text-muted-foreground">{processData() ? checked(processData()?.readAt ?? "") : "Server child processes"}</Text><Refresh label="Refresh process diagnostics" loading={processes().kind === "loading"} onPress={() => void refreshProcesses()} /></View>
        <StateMessage loading={processes().kind === "loading" || processes().kind === "idle"} loadingLabel={processData() ? undefined : "Loading live processes..."} error={loadError(processes()) ?? processData()?.error ?? null} />
        {processData() ? <View class="flex-row gap-4 border-t border-border px-4 py-3"><Stat label="Child Processes" amount={String(processData()?.processCount)} /><Stat label="CPU" amount={`${processData()?.totalCpuPercent.toFixed(1)}%`} /><Stat label="Memory" amount={bytes(processData()?.totalRssBytes ?? 0)} /><Stat label="Server PID" amount={String(processData()?.serverPid)} /></View> : null}
        {processData() && !processData()?.error && processData()?.processes.length === 0 ? <Text class="border-t border-border px-4 py-3 text-sm text-muted-foreground">No live descendant processes found.</Text> : null}
        <Each of={processData()?.processes ?? []} key={(row) => row.pid}>{(row) => <View class="gap-1 border-t border-border px-4 py-3"><Text class="text-sm text-foreground">{`${row().pid} · ${row().command}`}</Text><Text class="text-xs text-muted-foreground">{`${row().status} · ${row().elapsed} · ${row().cpuPercent.toFixed(1)}% CPU · ${bytes(row().rssBytes)} · parent ${row().ppid}`}</Text><View class="flex-row items-center gap-1.5"><View role="button" accessibilityLabel="Send SIGINT" disabled={signalingPid() === row().pid} onPress={() => void signalProcess(row(), "SIGINT")}><Text class="text-xs text-muted-foreground underline">INT</Text></View><View role="button" accessibilityLabel="Send SIGKILL" disabled={signalingPid() === row().pid} onPress={() => void signalProcess(row(), "SIGKILL")}><Text class="text-xs text-destructive-foreground underline">KILL</Text></View></View></View>}</Each>
      </SettingsSection>

      <SettingsSection title="Resource History">
        <View class="flex-row items-center gap-3 px-4 py-3"><Text class="flex-1 text-xs text-muted-foreground">{historyData() ? checked(historyData()?.readAt ?? "") : "Process resource samples"}</Text><WindowSelector label="Process history period" options={WINDOWS.map(({ windowMs, label }) => ({ value: windowMs, label }))} selected={() => WINDOWS.find((item) => item.value === historyWindow())?.windowMs ?? 900000} onSelect={(ms) => historyWindow.set(WINDOWS.find((item) => item.windowMs === ms)?.value ?? "15m")} /><Refresh label="Refresh resource history" loading={history().kind === "loading"} onPress={() => void refreshHistory(historyWindow())} /></View>
        <StateMessage loading={history().kind === "loading" || history().kind === "idle"} loadingLabel={historyData() ? undefined : "Collecting process resource samples..."} error={loadError(history()) ?? historyData()?.error ?? null} />
        {historyData() ? <View class="flex-row gap-4 border-t border-border px-4 py-3"><Stat label="CPU Time" amount={`${historyData()?.totalCpuSecondsApprox.toFixed(1)} s`} /><Stat label="Samples" amount={String(historyData()?.retainedSampleCount)} /><Stat label="Interval" amount={historyData()?.sampleIntervalMs === 0 ? "On demand" : duration(historyData()?.sampleIntervalMs ?? 0)} /><Stat label="Processes" amount={String(historyData()?.topProcesses.length)} /></View> : null}
        {historyData() && !historyData()?.error && historyData()?.topProcesses.length === 0 ? <Text class="border-t border-border px-4 py-3 text-sm text-muted-foreground">No process resource samples found for this window.</Text> : null}
        {historyData() && (historyData()?.topProcesses.length ?? 0) > 0 ? <ProcessResourceHistoryTable processes={historyData()!.topProcesses} /> : null}
      </SettingsSection>

      <SettingsSection title="Trace Diagnostics">
        <View class="flex-row items-center justify-between px-4 py-3"><Text class="text-xs text-muted-foreground">{traceData() ? checked(traceData()?.readAt ?? "") : "Trace records"}</Text><View class="flex-row items-center gap-1.5"><IconAction label="Open logs folder" icon="folder-open" disabled={!props.logsDirectoryPath || !props.openLogsFolder || openingLogs()} onPress={() => void openLogs()} /><Refresh label="Refresh trace diagnostics" loading={trace().kind === "loading"} onPress={() => void refreshTrace()} /></View></View>
        {logsError() ? <View class="px-4 pb-2"><ErrorLine message={logsError()!} /></View> : null}
        <StateMessage loading={trace().kind === "loading" || trace().kind === "idle"} error={loadError(trace()) ?? (traceData()?.error ? `${traceData()?.partialFailure ? "Some trace files could not be read, so diagnostics may be incomplete. " : ""}${traceData()?.error}` : null)} />
        {traceUsable() ? <View class="flex-row gap-4 border-t border-border px-4 py-3"><Stat label="Spans" amount={String(traceData()?.recordCount)} /><Stat label="Failures" amount={String(traceData()?.failureCount)} /><Stat label="Slow Spans" amount={String(traceData()?.slowSpanCount)} tooltip={traceData()?.slowSpanThresholdMs != null ? `Spans with a duration of ${duration(traceData()!.slowSpanThresholdMs!)} or longer.` : "Spans at or above the configured slow-span threshold."} /><Stat label="Parse Errors" amount={String(traceData()?.parseErrorCount)} /></View> : null}
      </SettingsSection>

      {traceUsable() || traceInitialLoading() ? <>
        <SettingsSection title="Latest Failures">{empty(traceData()?.latestFailures) ? <Text class="px-4 py-3 text-sm text-muted-foreground">{traceInitialLoading() ? "Loading failures..." : "No failed spans found."}</Text> : null}<Each of={traceData()?.latestFailures ?? []} key={(row) => row.key}>{(row) => <View class="gap-1 border-b border-border px-4 py-3"><Text class="text-sm text-foreground">{row().name}</Text><Text class="text-xs text-muted-foreground">{row().cause}</Text><Text class="text-xs text-muted-foreground">{`${duration(row().durationMs)} · ${time(row().endedAt)}`}</Text></View>}</Each></SettingsSection>
        <SettingsSection title="Most Common Failures">{empty(traceData()?.commonFailures) ? <Text class="px-4 py-3 text-sm text-muted-foreground">{traceInitialLoading() ? "Loading failure groups..." : "No repeated failures found."}</Text> : null}<Each of={traceData()?.commonFailures ?? []} key={(row) => row.key}>{(row) => <View class="gap-1 border-b border-border px-4 py-3"><Text class="text-sm text-foreground">{`${row().name} · ${row().count}`}</Text><Text class="text-xs text-muted-foreground">{row().cause}</Text><Text class="text-xs text-muted-foreground">{time(row().lastSeenAt)}</Text></View>}</Each></SettingsSection>
        <SettingsSection title="Slowest Spans">{empty(traceData()?.slowestSpans) ? <Text class="px-4 py-3 text-sm text-muted-foreground">{traceInitialLoading() ? "Loading slow spans..." : "No spans found."}</Text> : null}<Each of={traceData()?.slowestSpans ?? []} key={(row) => row.key}>{(row) => <View class="gap-1 border-b border-border px-4 py-3"><Text class="text-sm text-foreground">{`${row().name} · ${duration(row().durationMs)}`}</Text><Text class="text-xs text-muted-foreground">{time(row().endedAt)}</Text><TraceIdCell traceId={row().traceId} short={shortenTraceId(row().traceId)} /></View>}</Each></SettingsSection>
        <SettingsSection title="Span Logs">{empty(traceData()?.latestWarningAndErrorLogs) ? <Text class="px-4 py-3 text-sm text-muted-foreground">{traceInitialLoading() ? "Loading recent logs..." : "No warnings or errors found."}</Text> : null}<Each of={traceData()?.latestWarningAndErrorLogs ?? []} key={(row) => row.key}>{(row) => <View class="gap-1 border-b border-border px-4 py-3"><Text class="text-sm text-foreground">{`${row().level} · ${row().spanName}`}</Text><Text class="text-xs text-muted-foreground">{row().message}</Text><Text class="text-xs text-muted-foreground">{time(row().seenAt)}</Text></View>}</Each></SettingsSection>
        <SettingsSection title="Top Span Names">{empty(traceData()?.topSpansByCount) ? <Text class="px-4 py-3 text-sm text-muted-foreground">{traceInitialLoading() ? "Loading span names..." : "No spans found."}</Text> : null}<Each of={traceData()?.topSpansByCount ?? []} key={(row) => row.key}>{(row) => <View class="gap-1 border-b border-border px-4 py-3"><Text class="text-sm text-foreground">{row().name}</Text><Text class="text-xs text-muted-foreground">{`${row().count} spans · ${row().failureCount} failures · ${duration(row().averageDurationMs)} avg · ${duration(row().maxDurationMs)} max`}</Text></View>}</Each></SettingsSection>
      </> : null}
      <TelemetryExportSettings />
    </> : null}
  </View>;
}

const telemetryDeps: TelemetryDeps = {
  request: (method, payload) => requestBackend(method, payload),
  subscribe: (method, payload, onValue, onError) => subscribeBackend(method, payload, onValue, onError),
  confirm: (message) => confirm(message, { variant: "destructive" }),
  toast: (toast) => showToast(toast),
};

async function openLogsInEditor(path: string) {
  const config = await requestBackend("server.getConfig", {});
  const last = await Storage.getItem("lastEditor").catch(() => null);
  const editor = effectiveEditor(last, readAvailableEditors(config));
  if (!editor) throw new Error("No editor is available to open the folder.");
  await openInEditor(path, editor, requestBackend);
}

export function DiagnosticsSettings() {
  const logs = serverObservability()?.logsDirectoryPath;
  return <DiagnosticsView telemetry={telemetryDeps} logsDirectoryPath={typeof logs === "string" ? logs : null} openLogsFolder={openLogsInEditor} status={backendStatus()} connectionError={backendError()} environmentKey={backendUrl()} active={settingsOpen() && settingsSection() === "/settings/diagnostics"} request={requestBackend} onConnect={() => openSettings("/settings/connections")} />;
}
