// app/DesktopLifecycle.ts relaunch, for a port with no main process to ask: the launcher (tools/run_local.py) owns
// the window process (`launch_app`/`start_app`), the same way it already owns server-exposure changes
// (networkAccess.ts's `exposure-request.json`/`exposure-state.json` beside the app's bootstrap file).
//
// New file contract for the launcher (not yet consumed there -- see the report):
//   `<bootstrapDir>/relaunch-request.json`, written atomically (`.tmp` then renamed, same as exposure-request.json).
//   Contents: `{"id": string, "reason": string}` (`reason` is a short machine string, e.g.
//   "localEnvironmentEnabled=false" or "startup-recovery-retry").
//   The launcher's poll loop (tools/run_local.py, beside its `exposure_files.take_request()` call) should: read the
//   file, unlink it, then `stop_app(app, app_binary)` followed by `app = start_app()` -- the same restart path it
//   already runs for an exposure-mode change, but without touching the server. It should also unlink any stale
//   file at startup so a crash between write and restart cannot loop.
//   No ack file is required or read: a successful relaunch tears down the window that wrote the request, so there
//   is nothing left in this process to read a reply. requestRelaunch() only confirms the file was written; it does
//   not confirm the launcher acted on it.
import { rename, writeFile } from "fs/promises";
import process from "process";

export interface RelaunchIo {
  write(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

const realIo: RelaunchIo = { write: (p, t) => writeFile(p, t), rename: (a, b) => rename(a, b) };

type EnvLike = Partial<Record<string, string | undefined>>;

/** The same directory networkAccess.ts uses: beside the app's bootstrap file, named by the launcher's env var. */
export function relaunchDir(env: EnvLike = process.env): string | null {
  const file = env.T3GPUI_BOOTSTRAP_FILE;
  return file ? file.replace(/\/[^/]*$/, "") : null;
}

/** Whether the running launcher actually watches for and consumes `relaunch-request.json`. `tools/run_local.py`
 * does (see its main loop, `relaunch_file.exists()`) and sets this env var in `APP_ENV`. The installed macOS
 * launcher (`tools/r3_macos_launcher.c` forking `tools/r3_server_supervisor.swift`) starts the server once and
 * never reads this file, so without this check `requestRelaunch()` would write a request nobody answers and
 * report success anyway (the directory from `T3GPUI_BOOTSTRAP_FILE` exists either way) -- the caller then shows
 * a "Restarting..." toast that never resolves. */
export function launcherHandlesRelaunch(env: EnvLike = process.env): boolean {
  return env.T3GPUI_LAUNCHER_HANDLES_RELAUNCH === "1";
}

/** Writes the relaunch request; returns whether a launcher directory was found to write it to. A caller with no
 * directory (an older or installed launcher that cannot act on it, or a test) gets `false` and should fall back
 * to telling the user to quit and reopen the app themselves -- the setting or retry still took effect, just not
 * until the next manual launch. */
export async function requestRelaunch(reason: string, deps?: { dir?: string | null; io?: RelaunchIo; id?: () => string; env?: EnvLike }): Promise<boolean> {
  const env = deps?.env ?? process.env;
  const dir = deps?.dir !== undefined ? deps.dir : (launcherHandlesRelaunch(env) ? relaunchDir(env) : null);
  if (!dir) return false;
  const io = deps?.io ?? realIo;
  const id = deps?.id?.() ?? `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const tmp = `${dir}/relaunch-request.json.tmp`;
  await io.write(tmp, JSON.stringify({ id, reason }));
  await io.rename(tmp, `${dir}/relaunch-request.json`);
  return true;
}
