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
// Transport: this sandboxed webview can be neither spawned with an inherited fd nor asked its own pid (NSH's
// `process` module exposes no pid; see process.d.ts), so it cannot write `desktopTelemetryFd` directly, the way
// the reference's Electron main process does. Instead it drops each sample as a file next to the app's bootstrap
// file -- the same file-drop/poll contract `relaunchRequest.ts` uses for its own launcher hand-off, reusing
// `relaunchDir()` -- and `tools/run_local.py` (which already owns the server's pipes, e.g. the browser bridge's
// `bootstrap_pipe` in `tools/desktop_browser_bridge.py`) tails that file, fills in `sequence` and `electronPid`
// (its own pid, standing in for the reference's Electron pid) and forwards each sample into the fd it opened for
// the server (`tools/desktop_telemetry_relay.py`). No ack is read back; a lost sample is covered by the next tick.
import { rename, writeFile } from "fs/promises";
import { desktop } from "./runtime";
import { relaunchDir } from "./relaunchRequest";

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

export interface TelemetryIo {
  write(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

const realIo: TelemetryIo = { write: (p, t) => writeFile(p, t), rename: (a, b) => rename(a, b) };

export const TELEMETRY_SAMPLE_FILE = "telemetry-sample.json";

/** Drops one sample for `tools/desktop_telemetry_relay.py`'s `take_sample` (polled from run_local.py's main loop)
 * to forward into the server's `desktopTelemetryFd`. `sequence`/`hostPid` are placeholders the launcher
 * overwrites unconditionally when it forwards the frame -- only `sampledAtUnixMs` and `power` are read back from
 * this file; see the module note for why this webview cannot supply either itself. Same atomic-write/no-ack
 * contract as `relaunchRequest.ts`'s `requestRelaunch`. Returns whether a launcher directory was found to write
 * to; a caller with none (dev/web, no `tools/run_local.py`) gets `false` and the sample is simply not published. */
export async function publishHostTelemetry(sample: HostPowerSample, deps?: { dir?: string | null; io?: TelemetryIo }): Promise<boolean> {
  const dir = deps?.dir !== undefined ? deps.dir : relaunchDir();
  if (!dir) return false;
  const io = deps?.io ?? realIo;
  const message = buildHostTelemetryMessage(sample, { sequence: 0, hostPid: 1 });
  const tmp = `${dir}/${TELEMETRY_SAMPLE_FILE}.tmp`;
  await io.write(tmp, JSON.stringify(message));
  await io.rename(tmp, `${dir}/${TELEMETRY_SAMPLE_FILE}`);
  return true;
}

export interface HostTelemetryPublisherHandle { stop(): void }

/** One sample-and-publish pass; best effort -- a failure here is dropped, same as a tick the launcher's poll
 * loop missed, and is covered by the next sample. */
export async function publishHostTelemetryOnce(input: {
  readonly dir?: string | null;
  readonly io?: TelemetryIo;
  readonly sample?: () => Promise<HostPowerSample>;
  readonly onError?: (error: unknown) => void;
}): Promise<void> {
  const sample = input.sample ?? sampleHostPower;
  try {
    await publishHostTelemetry(await sample(), { dir: input.dir, io: input.io });
  } catch (error) {
    (input.onError ?? (() => undefined))(error);
  }
}

// Order-of-magnitude match for the reference's DesktopTelemetryPublisher sampling cadence; exact parity is not
// load-bearing since the server only ever shows the latest sample.
const SAMPLE_INTERVAL_MS = 15_000;

export function startHostTelemetryPublisher(input?: {
  readonly intervalMs?: number;
  readonly dir?: string | null;
  readonly io?: TelemetryIo;
  readonly sample?: () => Promise<HostPowerSample>;
  readonly onError?: (error: unknown) => void;
  readonly setInterval?: (fn: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}): HostTelemetryPublisherHandle {
  const intervalMs = input?.intervalMs ?? SAMPLE_INTERVAL_MS;
  const setIntervalFn = input?.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = input?.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let running = false;
  const tick = () => {
    if (running) return; // one sample-and-publish pass in flight at a time.
    running = true;
    void publishHostTelemetryOnce(input ?? {}).finally(() => { running = false; });
  };
  const timer = setIntervalFn(tick, intervalMs);
  tick();
  return { stop: () => clearIntervalFn(timer) };
}

let publisherStarted = false;

/** The app's own call: starts the periodic publisher once, only when a launcher directory exists (dev/web runs
 * with no `tools/run_local.py` bootstrap simply never publish). Never awaited or thrown from. */
export function startHostTelemetryPublishing(): void {
  if (publisherStarted) return;
  publisherStarted = true;
  if (!relaunchDir()) return;
  startHostTelemetryPublisher();
}
