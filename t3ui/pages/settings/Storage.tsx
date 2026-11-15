// Storage rows of Maintenance, ported from StorageSettings.tsx and
// DatabaseStorageNotice.tsx: "Delete now" with the last cleanup run beside it
// (`server.runStorageCleanup`, `server.getStorageCleanupReport`) and the Database
// section's "Reclaim freed database space", shown only when the server reports
// enough freed pages (`server.getDatabaseStorage`).
import { Clipboard, effect, signal, Text, untracked, View } from "nsh";
import { SettingsButton, SettingsRow, SettingsSection } from "../../components/SettingsLayout";
import { isServerConnected, requestServer, readSetting, subscribeServer } from "./settingsSync";
import { confirm, showToast } from "../../components/toast";
import { serverEnvironment } from "./settingsState";

const environmentLabel = () => { const label = serverEnvironment()?.label; return typeof label === "string" && label ? label : "this environment"; };

type Dict = Record<string, unknown>;
const dict = (value: unknown): Dict | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dict) : null);

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1000 && unit < units.length - 1) { amount /= 1000; unit++; }
  return `${unit === 0 ? amount : amount.toFixed(amount >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** formatRelativeTimeLabel for the last-run line. */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "recently";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export interface CleanupReport { finishedAt: string; removed: number; kept: number; failed: number; bytesFreed: number; failureReason: string | null }

export function parseCleanupReport(value: unknown): CleanupReport | null {
  const report = dict(value);
  const counts = dict(report?.counts);
  if (!report || !counts || typeof report.finishedAt !== "string") return null;
  const entries = Array.isArray(report.entries) ? report.entries : [];
  const failed = entries.map(dict).find((entry) => entry?.outcome === "failed");
  return {
    finishedAt: report.finishedAt,
    removed: Number(counts.removed ?? 0),
    kept: Number(counts.kept ?? 0),
    failed: Number(counts.failed ?? 0),
    bytesFreed: Number(report.bytesFreed ?? 0),
    failureReason: typeof failed?.reason === "string" ? failed.reason : null,
  };
}

/** The description line of the "Delete now" row. */
export function lastRunDescription(report: CleanupReport | null, state: "loading" | "failed" | "idle", now: number): string {
  if (report) {
    const failures = report.failed > 0 ? ` ${report.failed} ${report.failed === 1 ? "item" : "items"} couldn't be removed.` : "";
    return `Last run ${relativeTime(report.finishedAt, now)}. ${formatBytes(report.bytesFreed)} recovered.${failures}`;
  }
  return state === "failed" ? "Could not load the last run." : state === "loading" ? "Loading last run…" : "Cleanup hasn't run yet.";
}

const report = signal<CleanupReport | null>(null);
const reportState = signal<"loading" | "failed" | "idle">("idle");
const running = signal(false);

type Subscribe = (method: string, payload: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void) => () => void;

/** `server.getStorageCleanupReport` is a stream (contracts rpc.ts, stream: true): the web keeps it open while the panel is shown. */
export function loadCleanupReport(subscribe: Subscribe = subscribeServer): () => void {
  reportState.set("loading");
  return subscribe("server.getStorageCleanupReport", {}, (value) => {
    report.set(parseCleanupReport(value));
    reportState.set("idle");
  }, () => reportState.set("failed"));
}

export async function runCleanup(request: (method: string, payload: unknown) => Promise<unknown> = requestServer) {
  if (running()) return;
  running.set(true);
  try {
    const parsed = parseCleanupReport(await request("server.runStorageCleanup", {}));
    if (parsed) report.set(parsed);
    // StorageSettings.tsx deleteNow: the first failed entry's reason is a toast naming the environment.
    if (parsed && parsed.failureReason !== null) showToast({ type: "error", title: `Cleanup failed on ${environmentLabel()}`, description: parsed.failureReason });
  } catch (cause) {
    showToast({ type: "error", title: `Could not run cleanup on ${environmentLabel()}`, description: cause instanceof Error && cause.message ? cause.message : String(cause) });
  } finally {
    running.set(false);
  }
}

/** True when any cleanup rule is switched on, which is what the web's button needs. */
function hasRules(): boolean {
  const stored = dict(readSetting("storageCleanup", "server"));
  if (!stored) return false;
  return Boolean(stored.worktreeOnMerge || stored.worktreeOnDelete || stored.worktreeUnchanged || stored.worktreeAfterDays != null || stored.worktreeSettledAfterDays != null || stored.browserArtifactsAfterDays != null || stored.logsAfterDays != null);
}

/** The control of the "Delete now" row. */
export function DeleteNowControl() {
  effect(() => { if (isServerConnected()) return untracked(() => loadCleanupReport()); });
  return (
    <View class="items-end gap-1" testID={`Storage cleanup (${running() ? "running" : "idle"})`}>
      <SettingsButton
        label={running() ? "Deleting…" : "Delete now"}
        accessibilityLabel="Delete now"
        disabled={running() || !isServerConnected()}
        onPress={() => void runCleanup()}
      />
      <Text class="max-w-64 text-right text-xs text-muted-foreground">{!hasRules() && !report() ? "Turn on a cleanup rule to use this." : lastRunDescription(report(), reportState(), Date.now())}</Text>
    </View>
  );
}

export interface DatabaseStatus { databaseBytes: number; reclaimableBytes: number; incrementalVacuumEnabled: boolean; compactCommand: string; canReclaim: boolean; reclaimFailure?: string }

const DATABASE_COMPACTION_RECOMMENDED_BYTES = 1024 ** 3;

export function parseDatabaseStatus(value: unknown): DatabaseStatus | null {
  const status = dict(value);
  if (!status || typeof status.databaseBytes !== "number" || typeof status.reclaimableBytes !== "number") return null;
  return {
    databaseBytes: status.databaseBytes,
    reclaimableBytes: status.reclaimableBytes,
    incrementalVacuumEnabled: status.incrementalVacuumEnabled === true,
    compactCommand: typeof status.compactCommand === "string" ? status.compactCommand : "",
    canReclaim: status.canReclaim === true,
    ...(typeof status.reclaimFailure === "string" ? { reclaimFailure: status.reclaimFailure } : {}),
  };
}

/** shouldRecommendDatabaseCompaction, from contracts settings.ts. */
export function shouldRecommendCompaction(status: DatabaseStatus): boolean {
  return !status.incrementalVacuumEnabled && status.reclaimableBytes >= DATABASE_COMPACTION_RECOMMENDED_BYTES;
}

const database = signal<DatabaseStatus | null>(null);
const copied = signal(false);
const reclaimRequested = signal(false);

/** databaseReclaimMinutes (contracts settings.ts): about two live GiB a minute, at least one. */
export const databaseReclaimMinutes = (status: DatabaseStatus) => Math.max(1, Math.ceil((status.databaseBytes - status.reclaimableBytes) / 1024 ** 3 / 2));
export const formatGiB = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/** ReclaimRow's start: ask, then `server.reclaimDatabaseSpace`, which restarts the environment. */
export async function reclaimDatabaseSpace(status: DatabaseStatus, label: string, deps: { confirm: typeof confirm; request: (method: string, payload: unknown) => Promise<unknown> } = { confirm, request: requestServer }): Promise<boolean> {
  const amount = formatGiB(status.reclaimableBytes);
  const minutes = databaseReclaimMinutes(status);
  const confirmed = await deps.confirm(`Reclaim ${amount} on ${label}?\nR3 Code on ${label} stops, rebuilds its database, and starts again. It is offline for about ${minutes} min. Running agents stop when it restarts.`, { confirmLabel: "Restart and reclaim" });
  if (!confirmed) return false;
  reclaimRequested.set(true);
  try {
    await deps.request("server.reclaimDatabaseSpace", {});
    showToast({ type: "success", title: `Reclaiming ${amount} on ${label}`, description: `R3 Code there restarts and is back in about ${minutes} min.` });
    return true;
  } catch (cause) {
    reclaimRequested.set(false);
    showToast({ type: "error", title: `Could not reclaim space on ${label}`, description: cause instanceof Error && cause.message ? cause.message : "An error occurred." });
    return false;
  }
}

/** `server.getDatabaseStorage` is a stream too (contracts rpc.ts, stream: true). */
export function loadDatabaseStatus(subscribe: Subscribe = subscribeServer): () => void {
  return subscribe("server.getDatabaseStorage", {}, (value) => database.set(parseDatabaseStatus(value)), () => database.set(null));
}

/** The Database section: only when the server holds at least 1 GiB of freed pages. */
export function DatabaseStorageNotice() {
  effect(() => {
    if (isServerConnected()) return untracked(() => loadDatabaseStatus());
    else database.set(null);
  });
  const status = () => { const current = database(); return current && shouldRecommendCompaction(current) ? current : null; };
  return (
    <>
      {status() ? (
        <SettingsSection title="Database">
          {status()!.canReclaim ? <>
            <SettingsRow title="Reclaim freed database space" description="These databases still hold space freed by history cleanup." />
            <SettingsRow
              title={`${formatGiB(status()!.reclaimableBytes)} on ${environmentLabel()}`}
              description={status()!.reclaimFailure === undefined ? `Restarts R3 Code there. It is offline for about ${databaseReclaimMinutes(status()!)} min.` : `The last attempt failed: ${status()!.reclaimFailure}`}
              control={<SettingsButton label={reclaimRequested() && status()!.reclaimFailure === undefined ? "Restarting…" : "Reclaim"} disabled={reclaimRequested() && status()!.reclaimFailure === undefined} onPress={() => void reclaimDatabaseSpace(status()!, environmentLabel())} />}
            />
          </> : <SettingsRow
            title="Reclaim freed database space"
            description="This database still holds space freed by history cleanup. Run the command on the machine to reclaim it. It restarts the background service. Quit the desktop app first if it hosts the environment."
          >
            <View class="items-end gap-1">
              <Text class="font-mono text-xs text-muted-foreground">{status()!.compactCommand}</Text>
              <SettingsButton
                label={copied() ? "Copied" : "Copy command"}
                accessibilityLabel="Copy compact command"
                onPress={() => { void Clipboard.writeText(status()!.compactCommand).then(() => copied.set(true)).catch(() => {}); }}
              />
              <Text class="text-xs text-muted-foreground">{`${formatBytes(status()!.reclaimableBytes)} reclaimable of ${formatBytes(status()!.databaseBytes)}`}</Text>
            </View>
          </SettingsRow>}
        </SettingsSection>
      ) : null}
    </>
  );
}
