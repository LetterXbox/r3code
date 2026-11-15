// useAutoBalanceUpdateBanner.tsx: while a draft routes automatically, one notice covers every candidate machine that is
// updating, failed to update, or runs an older server (version mismatch): "Updating / Could not update / Update
// available for N machine(s)", "<n> need(s) a manual update", and Update all / Update N machines / Retry.
import { signal, Storage } from "nsh";
import { serverEnvironmentIdOf } from "./machineMentions";
import type { BannerItem } from "../components/banners/bannerTypes";
import { serverUpdateStageLabel, type ServerUpdateState } from "../components/banners/serverUpdate";
import { resolveVersionMismatch } from "../components/coordinators/connection.logic";
import { serverEnvironment } from "../pages/settings/settingsState";
import { environmentConfigs, environmentConnections, environmentServerVersion } from "./connectionManager";
import { automaticDraftMembers } from "./loadBalancing";
import { machineOfProject } from "./machines";
import { machineUpdateStates, runServerUpdate, updateCapabilities } from "./ServerUpdateAction";

export interface UpdateMachine {
  key: string; label: string; connected: boolean; remoteUpdate: boolean; targetVersion: string; state: ServerUpdateState; dismissKey: string | null;
}

/** The notice's copy for its machines, or null when none needs one. */
export function autoBalanceUpdateSummary(machines: readonly UpdateMachine[]): { title: string; status: "running" | "failed" | "idle"; description?: string; actionLabel: string | null; targets: UpdateMachine[] } | null {
  if (machines.length === 0) return null;
  const running = machines.filter((machine) => machine.state.status === "running").length;
  const failed = machines.filter((machine) => machine.state.status === "failed").length;
  const manual = machines.filter((machine) => !machine.remoteUpdate).length;
  const targets = machines.filter((machine) => machine.connected && machine.remoteUpdate && machine.state.status !== "running");
  const count = running || failed || machines.length;
  const prefix = running ? "Updating" : failed ? "Could not update" : "Update available for";
  const actionLabel = running === 0 && targets.length > 0
    ? failed > 0 ? "Retry" : targets.length === machines.length ? "Update all" : `Update ${targets.length} ${targets.length === 1 ? "machine" : "machines"}`
    : null;
  return {
    title: `${prefix} ${count} ${count === 1 ? "machine" : "machines"}`,
    status: running ? "running" : failed ? "failed" : "idle",
    ...(manual > 0 ? { description: `${manual} ${manual === 1 ? "needs" : "need"} a manual update` } : {}),
    actionLabel, targets,
  };
}

/** The machine's row in the notice's list ("Manual update required", "Ready to update to <v>", "Reconnect this machine to update"). */
export function updateMachineDetail(machine: UpdateMachine): string {
  if (machine.state.status === "running") return serverUpdateStageLabel(machine.state.stage);
  if (machine.state.status === "failed") return machine.state.message;
  if (!machine.remoteUpdate) return "Manual update required";
  return machine.connected ? `Ready to update to ${machine.targetVersion}` : "Reconnect this machine to update";
}

// versionSkew.ts: version-mismatch dismissals persist per environment and version pair
// ("t3code:version-mismatch-dismissals:v1" { keys }); a failed update is dismissed per failure (the state object).
const VERSION_MISMATCH_DISMISSALS_STORAGE_KEY = "t3code:version-mismatch-dismissals:v1";
const mismatchDismissals = signal<string[]>([]);
let mismatchDismissalsLoaded = false;
function loadMismatchDismissals() {
  if (mismatchDismissalsLoaded) return;
  mismatchDismissalsLoaded = true;
  void Storage.getItem(VERSION_MISMATCH_DISMISSALS_STORAGE_KEY).then((raw) => {
    try {
      const keys = raw ? (JSON.parse(raw) as { keys?: unknown }).keys : [];
      if (Array.isArray(keys)) mismatchDismissals.update((current) => [...new Set([...keys.filter((key): key is string => typeof key === "string"), ...current])]);
    } catch (error) { console.error("Could not read version-mismatch dismissals.", error); }
  }).catch(() => undefined);
}
/** buildVersionMismatchDismissalKey */
export const versionMismatchDismissalKey = (environmentId: string, mismatch: { clientVersion: string; serverVersion: string }) => `${environmentId}:${mismatch.clientVersion}:${mismatch.serverVersion}`;
export function isVersionMismatchDismissed(key: string | null): boolean { loadMismatchDismissals(); return key !== null && mismatchDismissals().includes(key); }
export function dismissVersionMismatch(key: string | null): void {
  if (!key || mismatchDismissals().includes(key)) return;
  mismatchDismissals.update((keys) => [...keys, key]);
  void Storage.setItem(VERSION_MISMATCH_DISMISSALS_STORAGE_KEY, JSON.stringify({ keys: mismatchDismissals() })).catch((error) => console.error("Could not persist version-mismatch dismissals.", error));
}
const dismissedFailures = new WeakSet<ServerUpdateState>();
const failureTick = signal(0);
const isFailureDismissed = (state: ServerUpdateState) => { failureTick(); return state.status === "failed" && dismissedFailures.has(state); };
const dismissFailure = (state: ServerUpdateState) => { if (state.status === "failed") { dismissedFailures.add(state); failureTick.update((n) => n + 1); } };

function candidateMachines(): UpdateMachine[] {
  return automaticDraftMembers().flatMap((member): UpdateMachine[] => {
    const machine = machineOfProject(member);
    if (!machine) return [];
    const config = machine.key === "primary" ? { environment: serverEnvironment() } : environmentConfigs()[machine.key] ?? null;
    const version = machine.key === "primary" ? (serverEnvironment()?.serverVersion as string | undefined) ?? null : environmentServerVersion(machine.key);
    const mismatch = resolveVersionMismatch(version);
    const state = machineUpdateStates()[machine.key] ?? { status: "idle" as const };
    const serverEnvironmentId = serverEnvironmentIdOf(machine.key, { environment: serverEnvironment() }) ?? machine.key;
    const dismissKey = mismatch ? versionMismatchDismissalKey(serverEnvironmentId, mismatch) : null;
    const hidden = state.status === "idle" ? !mismatch || isVersionMismatchDismissed(dismissKey) : isFailureDismissed(state);
    if (hidden) return [];
    const caps = updateCapabilities(config);
    return [{
      key: machine.key, label: machine.label, connected: machine.key === "primary" || environmentConnections()[machine.key]?.phase === "connected",
      remoteUpdate: caps.selfUpdate !== null && (caps.selfUpdate !== "desktop-managed" || caps.desktopAppUpdate),
      targetVersion: state.status === "idle" ? mismatch!.clientVersion : state.targetVersion, state, dismissKey,
    }];
  });
}

export function autoBalanceUpdateItem(): BannerItem | null {
  const machines = candidateMachines();
  const summary = autoBalanceUpdateSummary(machines);
  if (!summary) return null;
  const members = automaticDraftMembers();
  return {
    id: `auto-balance-server-updates-${mismatchDismissals().length}-${failureTick()}`,
    variant: summary.status === "failed" ? "error" : "default",
    group: "environment",
    icon: summary.status === "failed" ? "circle-alert" : "download",
    title: summary.title,
    titlePopover: { accessibilityLabel: `${summary.title}. View machines`, rows: machines.map((machine) => ({ key: machine.key, label: machine.label, detail: updateMachineDetail(machine) })) },
    ...(summary.description ? { description: summary.description } : {}),
    actions: summary.actionLabel ? [{
      id: "update-machines", label: summary.actionLabel, tone: "button",
      run: () => {
        for (const target of summary.targets) {
          const member = members.find((item) => machineOfProject(item)?.key === target.key);
          const machine = member ? machineOfProject(member) : null;
          if (!machine) continue;
          const config = target.key === "primary" ? { environment: serverEnvironment() } : environmentConfigs()[target.key] ?? null;
          const caps = updateCapabilities(config);
          void runServerUpdate({ key: target.key, serverLabel: target.label, selfUpdate: caps.selfUpdate, targetVersion: target.targetVersion, request: machine.request, progress: caps.progress, subscribe: machine.subscribe });
        }
      },
    }] : [],
    ...(summary.status === "running" ? {} : {
      dismissLabel: "Dismiss update notice",
      onDismiss: () => { for (const machine of machines) { dismissFailure(machine.state); dismissVersionMismatch(machine.dismissKey); } },
    }),
  };
}
