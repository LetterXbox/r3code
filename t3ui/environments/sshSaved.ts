// The SSH environments' runtime: the real process runner and CLI runner for environments/sshEnvironment.ts, and the
// hook that brings a saved SSH environment's tunnel up before it is probed or connected (savedEnvironments.ts,
// connectionManager.ts). The remote T3 is the version this app's server runs (the reference uses the app's version).
import process from "process";
import { serverEnvironment } from "../pages/settings/settingsState";
import { setSshRouteDisconnector, setSshRouteEnsurer, type SavedSshRoute } from "../pages/settings/environments/savedEnvironments";
import { setEnvironmentPreconnect } from "./connectionManager";
import { activeSshTunnels } from "./ssh";
import { disconnectSshEnvironment, ensureSshEnvironment, targetConnectionKey, type ScriptRunner, type SshEnvironmentDeps } from "./sshEnvironment";

export const processRunner = process as unknown as ScriptRunner;

/** resolveDesktopSshCliRunner: the release archive of the version this app runs. */
export function sshCliRunner(): SshEnvironmentDeps["cliRunner"] {
  const version = serverEnvironment()?.serverVersion;
  if (typeof version !== "string" || !version) throw new Error("Connect this app's environment first: the SSH host runs the same T3 Code version.");
  return { archiveVersion: version };
}

export const sshDeps = (): SshEnvironmentDeps => ({ runner: processRunner, cliRunner: sshCliRunner() });

const pending = new Map<string, Promise<void>>();

/** Once per route at a time, and not while its tunnel is already up. */
export function ensureSavedSshRoute(route: SavedSshRoute, deps: () => SshEnvironmentDeps = sshDeps): Promise<void> {
  const key = targetConnectionKey(route.target);
  if (activeSshTunnels().includes(key)) return Promise.resolve();
  const running = pending.get(key);
  if (running) return running;
  const next = ensureSshEnvironment(route.target, route.localPort, deps()).then(() => undefined).finally(() => pending.delete(key));
  pending.set(key, next);
  return next;
}

let installed = false;
export function installSshEnvironments() {
  if (installed) return;
  installed = true;
  setSshRouteEnsurer((route) => ensureSavedSshRoute(route));
  setSshRouteDisconnector(async (route) => {
    try { await disconnectSshEnvironment(route.target, { runner: processRunner, cliRunner: { archiveVersion: "" } }); }
    catch (error) { console.warn("Could not disconnect the managed SSH environment.", error); }
  });
  setEnvironmentPreconnect(async (environment) => { if (environment.ssh) await ensureSavedSshRoute(environment.ssh as SavedSshRoute); });
}
