// LegacyThreadMigrationToast.ts and HostFreezeToastCoordinator.ts: the two toasts the server's own streams raise.
import { effect, untracked } from "nsh";
import { serverEnvironment } from "../../pages/settings/settingsState";
import { closeToast, showToast } from "../toast/toastState";
import { legacyThreadMigration, serverEventLoopStall, type EventLoopStall, type LegacyThreadMigration } from "./serverStreams";

export const LEGACY_MIGRATION_TOAST_ID = "legacy-thread-migration";

/** The loading toast the web shows while the server reports a legacy thread migration running; null once it is not. */
export function legacyMigrationToast(migration: LegacyThreadMigration | null) {
  if (migration?.status !== "running") return null;
  return {
    type: "loading" as const,
    title: "Restoring your threads…",
    description: `Migrating ${migration.totalThreadCount.toLocaleString()} ${migration.totalThreadCount === 1 ? "thread" : "threads"} from the previous version. You can keep working while this finishes.`,
    timeoutMs: 0,
  };
}

/** hostFreezeNotice (client-runtime connection/hostFreeze.ts). */
export function hostFreezeNotice(hostLabel: string, stall: EventLoopStall | null): { title: string; description: string } | null {
  if (stall === null) return null;
  const { loadAverage, cpuCount } = stall;
  return {
    title: `${hostLabel} froze for ${Math.round(stall.durationMs / 1000)}s`,
    description: loadAverage !== undefined && loadAverage > cpuCount
      ? `Its CPU is overloaded (load ${Math.round(loadAverage)} on ${cpuCount} cores).`
      : `R3 Code on ${hostLabel} was too busy to answer.`,
  };
}

const shownStalls = new Set<string>();

/** Tells the user why a host dropped, once per stall, when it reports one on reconnect. */
export function showHostFreezeToast(stall: EventLoopStall | null, hostLabel: string): boolean {
  if (stall === null) return false;
  const key = `${hostLabel}:${stall.detectedAt}`;
  if (shownStalls.has(key)) return false;
  shownStalls.add(key);
  const notice = hostFreezeNotice(hostLabel, stall);
  if (notice === null) return false;
  showToast({ type: "warning", ...notice });
  return true;
}

export function resetHostFreezeToastsForTest() { shownStalls.clear(); }

let installed = false;

export function installLifecycleToasts() {
  if (installed) return;
  installed = true;
  effect(() => {
    const toast = legacyMigrationToast(legacyThreadMigration());
    untracked(() => {
      if (toast) showToast({ id: LEGACY_MIGRATION_TOAST_ID, ...toast });
      else closeToast(LEGACY_MIGRATION_TOAST_ID);
    });
  });
  effect(() => {
    const stall = serverEventLoopStall();
    const label = serverEnvironment()?.label;
    untracked(() => showHostFreezeToast(stall, typeof label === "string" ? label : "This computer"));
  });
}
