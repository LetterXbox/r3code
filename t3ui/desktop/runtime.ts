// The native capabilities the reference's Electron main process provides (packages/contracts ipc.ts DesktopBridge), in one
// place. This app IS the desktop client: every bridge capability is served here through NSH's own runtime (`process`,
// `fs/promises`, `openUrl`, `Storage`). Tests swap the runtime with `configureDesktop`, so no test ever runs a real
// command (a real screencapture would capture the owner's screen or raise a macOS permission prompt).
import { mkdir, stat, unlink, writeFile } from "fs/promises";
import { openUrl, platform, Storage } from "nsh";
import process from "process";

export interface RunResult { code?: number | null; signal?: string | null; stdout: string; stderr: string }

export interface DesktopRuntime {
  /** `process.run`: an absolute executable granted by nsh.json `capabilities.process.execute`. */
  run: (command: string, args: string[], options?: { timeoutMs?: number | null }) => Promise<RunResult>;
  writeFile: (path: string, data: string | Uint8Array) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  /** The size of a file, `null` when it does not exist. */
  fileSize: (path: string) => Promise<number | null>;
  openUrl: (url: string) => Promise<boolean>;
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  /** "macos", "windows", "linux" ... (NSH's spelling). */
  os: () => string;
  /** The app's writable data directory. */
  dataDir: () => string | null;
  randomId: () => string;
  now: () => Date;
}

const realRuntime: DesktopRuntime = {
  run: (command, args, options) => process.run(command, args, { timeoutMs: options?.timeoutMs ?? null }),
  writeFile: (path, data) => writeFile(path, data),
  mkdir: (path) => mkdir(path, { recursive: true }),
  unlink: (path) => unlink(path),
  fileSize: async (path) => {
    try { return (await stat(path)).size; } catch { return null; }
  },
  openUrl: async (url) => (await openUrl(url)).opened,
  getItem: (key) => Storage.getItem(key),
  setItem: (key, value) => Storage.setItem(key, value),
  os: () => platform.os,
  dataDir: () => process.dataDir,
  randomId: () => crypto.randomUUID(),
  now: () => new Date(),
};

let runtime: DesktopRuntime = realRuntime;

/** Tests replace parts of the runtime; the app never calls this. */
export function configureDesktop(next: Partial<DesktopRuntime>) {
  runtime = { ...runtime, ...next };
}

export const desktop = (): DesktopRuntime => runtime;

/** The folder the native helpers write to: `<dataDir>/snapshots` (granted in nsh.json `capabilities.fs.write`). */
export function snapshotsDir(): string | null {
  const dir = runtime.dataDir();
  return dir ? `${dir.replace(/\/+$/, "")}/snapshots` : null;
}

export const isMac = () => runtime.os() === "macos";
