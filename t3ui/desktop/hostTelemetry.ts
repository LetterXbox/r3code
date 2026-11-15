// Host power/thermal/battery/idle sampling (reference: telemetry/DesktopTelemetryPublisher.ts,
// DesktopRendererHistory.ts). The reference's Electron main process reads these from native powerMonitor APIs and
// its own process metrics, then streams them to the server over an inherited file descriptor
// (backend/DesktopBackendManager.ts spawns the server with `desktopTelemetryFd`/`desktopTelemetryControlFd`; the
// receiving side already exists in this port: server-rs/src/background_activity.rs `ingest_desktop_telemetry` /
// `start_desktop_telemetry`, wired from `config.desktop_telemetry_fd` in server-rs/src/server.rs).
//
// This module builds the SAMPLING half only, run through `pmset`/`ioreg` (added to nsh.json's process.execute
// allowlist) via desktop/runtime.ts, matching the exact wire shape server-rs's `ingest_desktop_telemetry` validates
// (`power.source`'s enum already has a `"node-macos-shell"` value for precisely this: a non-Electron host sampling
// over shell commands instead of native OS APIs).
//
// NOT WIRED to a transport: server-rs only ingests this over the fd it is spawned with, and spawning the server is
// `tools/run_local.py`'s job (the launcher process), not this sandboxed webview. There is also no current source for
// `electronPid` (NSH's `process` module exposes no pid; see process.d.ts) even though the server's validator
// requires a nonzero one. Both gaps need either a new NSH host call (native, out of this change's reach) or moving
// the whole publish loop into `tools/run_local.py` (which already owns the server's pipes, e.g. the browser bridge's
// `bootstrap_pipe` in tools/desktop_browser_bridge.py) — a decision for whoever wires the transport, not guessed here.
import { desktop } from "./runtime";

export type ThermalState = "unknown" | "nominal" | "fair" | "serious" | "critical";
export type TriState = "true" | "false" | "unknown";

export interface HostPowerSample {
  onBattery: TriState;
  thermalState: ThermalState;
  idleSeconds: number | null;
}

/** `pmset -g batt`'s first line: `Now drawing from 'AC Power'` or `'Battery Power'`. */
export function parsePmsetBattery(output: string): TriState {
  const match = /Now drawing from '([^']+)'/.exec(output);
  if (!match) return "unknown";
  if (match[1] === "Battery Power") return "true";
  if (match[1] === "AC Power") return "false";
  return "unknown";
}

/** `pmset -g therm`'s `CPU_Speed_Limit` percentage, the closest shell-visible proxy for macOS's (private)
 * thermal-pressure levels: 100% nominal, then progressively throttled. There is no public CLI for the native
 * `NSProcessInfoThermalState` buckets themselves, so this is a documented approximation, not a 1:1 port. */
export function parsePmsetThermal(output: string): ThermalState {
  const match = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(output);
  if (!match) return "unknown";
  const percent = Number(match[1]);
  if (!Number.isFinite(percent)) return "unknown";
  if (percent >= 100) return "nominal";
  if (percent >= 80) return "fair";
  if (percent >= 50) return "serious";
  return "critical";
}

/** `ioreg -c IOHIDSystem`'s `HIDIdleTime` is nanoseconds since the last HID event. */
export function parseIoregIdleSeconds(output: string): number | null {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(output);
  if (!match) return null;
  const nanoseconds = Number(match[1]);
  return Number.isFinite(nanoseconds) ? nanoseconds / 1e9 : null;
}

const IDLE_THRESHOLD_SECONDS = 60; // Matches the reference's IDLE_THRESHOLD_SECONDS.

export function idleTriState(idleSeconds: number | null): TriState {
  if (idleSeconds === null) return "unknown";
  return idleSeconds >= IDLE_THRESHOLD_SECONDS ? "true" : "false";
}

/** Runs `pmset -g batt`, `pmset -g therm`, `ioreg -c IOHIDSystem` and folds their output into one sample. Any one
 * command failing (not macOS, binary missing, timeout) degrades that field to "unknown"/`null` rather than failing
 * the whole sample. */
export async function sampleHostPower(): Promise<HostPowerSample> {
  const runtime = desktop();
  const [batt, therm, hid] = await Promise.all([
    runtime.run("/usr/bin/pmset", ["-g", "batt"]).then((result) => result.stdout, () => ""),
    runtime.run("/usr/bin/pmset", ["-g", "therm"]).then((result) => result.stdout, () => ""),
    runtime.run("/usr/sbin/ioreg", ["-c", "IOHIDSystem"]).then((result) => result.stdout, () => ""),
  ]);
  return {
    onBattery: parsePmsetBattery(batt),
    thermalState: parsePmsetThermal(therm),
    idleSeconds: parseIoregIdleSeconds(hid),
  };
}

/** The wire shape server-rs/src/background_activity.rs `ingest_desktop_telemetry` validates for `type:
 * "desktopTelemetry"`. `hostPid` stands in for the reference's `electronPid` (see the module note above: this port
 * has no real source for it yet, so callers must supply one or the message will fail server-side validation, same
 * as a zero/missing value does in the reference). */
export function buildHostTelemetryMessage(sample: HostPowerSample, options: { sequence: number; hostPid: number; sampledAt?: Date }) {
  const sampledAt = options.sampledAt ?? new Date();
  return {
    version: 1 as const,
    type: "desktopTelemetry" as const,
    sequence: options.sequence,
    sampledAtUnixMs: sampledAt.getTime(),
    electronPid: options.hostPid,
    power: {
      source: "node-macos-shell" as const,
      idle: idleTriState(sample.idleSeconds),
      idleSeconds: sample.idleSeconds ?? 0,
      locked: "unknown" as const, // No shell-visible screen-lock signal; the reference's native API has no equivalent here.
      suspended: false,
      onBattery: sample.onBattery,
      lowPowerMode: "unknown" as const,
      thermalState: sample.thermalState,
      stale: false,
      updatedAt: sampledAt.toISOString(),
    },
    electronProcesses: [] as const, // No native process-metrics source from the sandbox; see the module note.
  };
}
