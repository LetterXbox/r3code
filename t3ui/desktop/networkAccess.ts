// desktopNetworkAccess.ts + the bridge's getServerExposureState / getAdvertisedEndpoints / setServerExposureMode /
// setTailscaleServeEnabled. The launcher owns the server (tools/server_exposure.py): it publishes
// `exposure-state.json` beside the app's bootstrap file and applies `exposure-request.json`, restarting the server and
// this window as the reference relaunches the app. Without the state file (an older launcher) nothing here is offered.
import { readFile, rename, writeFile } from "fs/promises";
import { signal } from "nsh";
import process from "process";
import type { AdvertisedEndpoint } from "../pages/settings/environments/connectionsLogic";

export type ServerExposureMode = "local-only" | "network-accessible";
export interface ServerExposureState {
  mode: ServerExposureMode;
  endpointUrl: string | null;
  advertisedHost: string | null;
  tailscaleServeEnabled: boolean;
  tailscaleServePort: number;
}
export interface NetworkAccessSnapshot {
  serverExposureState: ServerExposureState;
  advertisedEndpoints: AdvertisedEndpoint[];
  lastResult?: { id: string | null; ok: boolean; error?: string };
}

export interface NetworkAccessIo {
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}
const realIo: NetworkAccessIo = { read: (p) => readFile(p, "utf8"), write: (p, t) => writeFile(p, t), rename: (a, b) => rename(a, b) };

export function exposureDir(): string | null {
  const file = process.env.T3GPUI_BOOTSTRAP_FILE;
  return file ? file.replace(/\/[^/]*$/, "") : null;
}

export function parseSnapshot(text: string): NetworkAccessSnapshot | null {
  try {
    const value = JSON.parse(text) as NetworkAccessSnapshot;
    const state = value?.serverExposureState;
    if (!state || (state.mode !== "local-only" && state.mode !== "network-accessible") || !Array.isArray(value.advertisedEndpoints)) return null;
    return value;
  } catch {
    return null;
  }
}

export function createNetworkAccess(deps: { dir: string; io?: NetworkAccessIo; wait?: (ms: number) => Promise<void>; id?: () => string }) {
  const io = deps.io ?? realIo;
  const wait = deps.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const snapshot = signal<NetworkAccessSnapshot | null>(null);
  const error = signal<string | null>(null);
  const loaded = signal(false);
  const refresh = async () => {
    try { snapshot.set(parseSnapshot(await io.read(`${deps.dir}/exposure-state.json`))); error.set(null); } catch { snapshot.set(null); }
    loaded.set(true);
  };
  /** Writes the request and waits for the launcher's answer; throws its error. A restart ends this window first. */
  const request = async (body: Record<string, unknown>) => {
    const id = deps.id?.() ?? `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const tmp = `${deps.dir}/exposure-request.json.tmp`;
    await io.write(tmp, JSON.stringify({ id, ...body }));
    await io.rename(tmp, `${deps.dir}/exposure-request.json`);
    for (let i = 0; i < 240; i++) {
      await wait(250);
      const next = parseSnapshot(await io.read(`${deps.dir}/exposure-state.json`).catch(() => ""));
      if (next?.lastResult?.id === id) {
        snapshot.set(next);
        if (!next.lastResult.ok) throw new Error(next.lastResult.error || "Failed to update network exposure.");
        return next;
      }
    }
    throw new Error("The launcher did not answer.");
  };
  return {
    snapshot: () => snapshot(),
    loaded: () => loaded(),
    error: () => error(),
    refresh,
    setServerExposureMode: (mode: ServerExposureMode) => request({ mode }),
    setTailscaleServeEnabled: (input: { enabled: boolean; port?: number }) => request({ tailscaleServe: input }),
  };
}

let instance: ReturnType<typeof createNetworkAccess> | null = null;
/** The app's network access bridge; null without a launcher that publishes the state. */
export function networkAccess() {
  const dir = exposureDir();
  if (!dir) return null;
  if (!instance) instance = createNetworkAccess({ dir });
  return instance;
}
