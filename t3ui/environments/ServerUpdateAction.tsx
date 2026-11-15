// ServerUpdateAction (apps/web/src/components/ServerUpdateAction.tsx): the Update control on an environment row whose
// server is behind. A server that can update itself gets `server.updateServer`; one that cannot gets the manual
// command to copy (manualServerUpdateCommand, versionSkew.ts); a desktop-managed one without desktopAppUpdate gets the note.
import { Clipboard, signal, Text } from "nsh";
import { fetchSessionGrant, sessionGrantsScope } from "../backend/providers";
import { SettingsButton } from "../components/SettingsLayout";
import { confirm, showToast } from "../components/toast";
import { record, RequestFailure } from "../backend/client";
import { serverUpdateState, type ServerUpdateState } from "../components/banners/serverUpdate";

export type SelfUpdate = "boot-service" | "respawn" | "desktop-managed" | null;
export type Installation = { kind: "npx" | "pnpm-dlx" | "bunx" } | { kind: "npm-global"; prefix: string } | undefined;

export function manualServerUpdateCommand(targetVersion: string, installation?: Installation): string {
  if (installation?.kind === "npm-global") {
    const prefix = `'${installation.prefix.replaceAll("'", "'\\''")}'`;
    return `npm install --global --prefix ${prefix} t3@${targetVersion}`;
  }
  const runner = installation?.kind === "pnpm-dlx" ? "pnpm dlx" : installation?.kind === "bunx" ? "bunx" : "npx";
  return `${runner} t3@${targetVersion}`;
}

/** The descriptor's update capabilities (ExecutionEnvironmentCapabilities) from a server.getConfig result. */
export function updateCapabilities(config: unknown): { selfUpdate: SelfUpdate; installation: Installation; desktopAppUpdate: boolean; progress: boolean } {
  const capabilities = record(record(record(config)?.environment)?.capabilities);
  const raw = capabilities?.serverSelfUpdate;
  const selfUpdate: SelfUpdate = raw === "boot-service" || raw === "respawn" || raw === "desktop-managed" ? raw : null;
  const install = record(capabilities?.serverInstallation);
  const installation: Installation = install?.kind === "npm-global" && typeof install.prefix === "string" ? { kind: "npm-global", prefix: install.prefix }
    : install?.kind === "npx" || install?.kind === "pnpm-dlx" || install?.kind === "bunx" ? { kind: install.kind } : undefined;
  return { selfUpdate, installation, desktopAppUpdate: capabilities?.desktopAppUpdate === true, progress: capabilities?.serverSelfUpdateProgress === true };
}

export type ServerUpdatePlan =
  | { kind: "note"; text: string }
  | { kind: "copy"; label: string; command: string; title: string; description: string }
  | { kind: "update"; label: string; confirm: string | null };

export function planServerUpdate(input: { serverLabel: string; targetVersion: string; selfUpdate: SelfUpdate; installation: Installation; desktopAppUpdate: boolean; label?: string }): ServerUpdatePlan {
  if (input.selfUpdate === "desktop-managed" && !input.desktopAppUpdate) {
    return { kind: "note", text: "Update the desktop app on that machine to update this server." };
  }
  if (input.selfUpdate === null) {
    const command = manualServerUpdateCommand(input.targetVersion, input.installation);
    const npm = input.installation?.kind === "npm-global";
    return {
      kind: "copy", command,
      label: npm ? "Copy update command" : "Copy relaunch command",
      title: npm ? "Update command copied" : "Relaunch command copied",
      description: npm
        ? `Run \`${command}\` on ${input.serverLabel}, then restart t3 with your usual options.`
        : `Stop t3 on ${input.serverLabel}, then relaunch with \`${command}\` using the same subcommand and options. This does not update an installed t3 command.`,
    };
  }
  return {
    kind: "update", label: input.label ?? "Update",
    confirm: input.selfUpdate === "desktop-managed"
      ? `Update the R3 Code desktop app that runs the ${input.serverLabel}? It will close and relaunch on that machine.` : null,
  };
}

const pending = new Set<string>();
/** The environments whose last update failed (serverEnvironment.updateStateAtom status "failed"): the button says Retry update. */
const failedUpdates = signal<string[]>([]);
export const serverUpdateFailed = (key: string) => failedUpdates().includes(key);

// canUpdateServer: the session must be authenticated and grant AuthEnvironmentMaintainScope ("environment:maintain").
const grants = signal<Record<string, boolean>>({});
const asked = new Set<string>();
let grantOverride: ((key: string) => boolean | null) | null = null;
/** Tests: answer the maintain grant without an HTTP session. */
export function setMaintainGrantForTest(read: ((key: string) => boolean | null) | null) { grantOverride = read; grants.set({}); }
export function canMaintain(key: string, url: string, bearer: () => Promise<string | null>): boolean {
  if (grantOverride) return grantOverride(key) === true;
  if (!asked.has(key)) {
    asked.add(key);
    void bearer().then((token) => (token ? fetchSessionGrant(url, token) : null)).then((session) => {
      grants.update((all) => ({ ...all, [key]: session !== null && sessionGrantsScope(session, "environment:maintain") }));
    }).catch(() => { asked.delete(key); });
  }
  return grants()[key] === true;
}

type Subscribe = (method: string, payload: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void) => () => void;
export type ServerUpdateInput = {
  key: string; serverLabel: string; selfUpdate: SelfUpdate; targetVersion: string; request: (method: string, payload: unknown) => Promise<unknown>;
  /** capabilities.serverSelfUpdateProgress: the update runs as `server.updateServerWithProgress` through `subscribe`. */
  progress?: boolean; subscribe?: Subscribe; fromVersion?: string;
};
type SelfUpdateResult = { targetVersion: string; method: string; desktopUpdateToken?: string };
type Stage = "downloading" | "installing" | "resuming";

/** The server ended the stream (an Exit Success): BackendClient reports it with this message. */
const STREAM_ENDED = "Environment subscription ended unexpectedly";
/** The errors BackendClient and store.ts close a lost socket with (client.ts read/close/heartbeat, store.ts health check). */
const SOCKET_LOSS = new Set([
  "The environment closed the connection", "Environment disconnected", "Environment stopped responding",
  "The environment did not respond to a connection health check.",
]);
/** isLegacyUpdateHandoffLoss: only the socket going away (the server restarting) is a handoff, never a failure the
 * server answered or a request this client refused to send. */
const isHandoffLoss = (error: unknown) => !(error instanceof RequestFailure) && error instanceof Error && SOCKET_LOSS.has(error.message);
const readResult = (value: unknown, targetVersion: string): SelfUpdateResult => {
  const r = record(value);
  return { targetVersion: typeof r?.targetVersion === "string" ? r.targetVersion : targetVersion, method: typeof r?.method === "string" ? r.method : "", ...(typeof r?.desktopUpdateToken === "string" ? { desktopUpdateToken: r.desktopUpdateToken } : {}) };
};

/**
 * client-runtime server.ts updateServer: `server.updateServerWithProgress` when the server reports progress (stages
 * drive the notice; resolveServerUpdateProgressResult settles it), else `server.updateServer`; a boot-service or
 * respawn server that drops the socket mid-handoff has accepted the restart. A desktop-app result with a token is then
 * committed with `server.commitDesktopUpdate` (the commit relaunches the app, so a dropped socket is success).
 */
export async function performServerUpdate(input: ServerUpdateInput, onStage: (stage: Stage) => void): Promise<SelfUpdateResult> {
  const { targetVersion } = input;
  const restarts = input.selfUpdate === "boot-service" || input.selfUpdate === "respawn";
  let result: SelfUpdateResult;
  if (input.progress && input.subscribe) {
    const subscribe = input.subscribe;
    result = await new Promise<SelfUpdateResult>((resolve, reject) => {
      let terminal: SelfUpdateResult | null = null;
      let receivedProgress = false;
      subscribe("server.updateServerWithProgress", { targetVersion }, (value) => {
        const event = record(value);
        if (event?.type === "complete") {
          terminal = readResult(event.result, targetVersion);
          onStage(terminal.method === "desktop-app" && terminal.desktopUpdateToken !== undefined ? "installing" : "resuming");
        } else if (event?.type === "progress" && (event.stage === "downloading" || event.stage === "installing")) {
          receivedProgress = true;
          onStage(event.stage);
        }
      }, (error) => {
        const ended = error.message === STREAM_ENDED;
        if (terminal && (ended || isHandoffLoss(error))) resolve(terminal);
        else if (!ended) {
          if (receivedProgress && restarts && isHandoffLoss(error)) resolve({ targetVersion, method: input.selfUpdate! });
          else reject(error);
        } else reject(new Error(`The t3@${targetVersion} update ended before the server accepted the restart.`));
      });
    });
  } else {
    try {
      result = readResult(await input.request("server.updateServer", { targetVersion }), targetVersion);
    } catch (error) {
      if (!(restarts && isHandoffLoss(error))) throw error;
      result = { targetVersion, method: input.selfUpdate! };
    }
  }
  if (result.method === "desktop-app" && result.desktopUpdateToken !== undefined) {
    try { await input.request("server.commitDesktopUpdate", { requestId: result.desktopUpdateToken }); } catch (error) { if (!isHandoffLoss(error)) throw error; }
  }
  onStage("resuming");
  return result;
}
let lastUpdate: ServerUpdateInput | null = null;
/** environmentUpdateStatesAtom: each machine's update progress, by its key ("primary" or a saved environment id). */
export const machineUpdateStates = signal<Record<string, ServerUpdateState>>({});
const setMachineState = (key: string, state: ServerUpdateState) => machineUpdateStates.update((all) => ({ ...all, [key]: state }));
/** The composer notice's Retry (ServerUpdateAction in useSystemComposerBanners): re-runs the update that just failed. */
export const canRetryServerUpdate = () => lastUpdate !== null && serverUpdateState().status === "failed";
export function retryServerUpdate(): Promise<void> { return lastUpdate ? runServerUpdate(lastUpdate) : Promise.resolve(); }

/** useServerUpdate: toasts the outcome, never rejects. Drives serverUpdateState (running, then idle or failed) for the composer notice. */
export async function runServerUpdate(input: ServerUpdateInput) {
  if (pending.has(input.key)) return;
  pending.add(input.key);
  lastUpdate = input;
  let stage: Stage = "downloading";
  const fromVersion = input.fromVersion ?? input.targetVersion;
  serverUpdateState.set({ status: "running", stage, fromVersion, targetVersion: input.targetVersion }); setMachineState(input.key, { status: "running", stage, fromVersion, targetVersion: input.targetVersion });
  try {
    const result = await performServerUpdate(input, (next) => { stage = next; serverUpdateState.set({ status: "running", stage, fromVersion, targetVersion: input.targetVersion }); setMachineState(input.key, { status: "running", stage, fromVersion, targetVersion: input.targetVersion }); });
    const version = result.targetVersion;
    failedUpdates.update((keys) => keys.filter((key) => key !== input.key));
    serverUpdateState.set({ status: "idle" }); setMachineState(input.key, { status: "idle" });
    showToast({ type: "success", title: `${input.serverLabel} updated`,
      description: input.selfUpdate === "desktop-managed" ? `Desktop app relaunched on ${version}.` : `Reconnected on t3@${version}.` });
  } catch (error) {
    failedUpdates.update((keys) => (keys.includes(input.key) ? keys : [...keys, input.key]));
    const message = error instanceof Error ? error.message : "Server update failed.";
    serverUpdateState.set({ status: "failed", stage, fromVersion, targetVersion: input.targetVersion, message }); setMachineState(input.key, { status: "failed", stage, fromVersion, targetVersion: input.targetVersion, message });
    showToast({ type: "error", title: `${input.serverLabel} update failed`, description: message });
  } finally {
    pending.delete(input.key);
  }
}

export function ServerUpdateAction(props: { environmentKey: string; serverLabel: string; targetVersion: string; config: unknown; url: string; bearer: () => Promise<string | null>; request: (method: string, payload: unknown) => Promise<unknown>; subscribe?: Subscribe; fromVersion?: string }) {
  const caps = () => updateCapabilities(props.config);
  const plan = () => planServerUpdate({ serverLabel: props.serverLabel, targetVersion: props.targetVersion, ...caps(), label: serverUpdateFailed(props.environmentKey) ? "Retry update" : "Update" });
  return () => {
    const current = plan();
    if (current.kind === "note") return <Text class="text-xs text-muted-foreground">{current.text}</Text>;
    if (current.kind === "copy") {
      return (
        <SettingsButton
          label={current.label}
          onPress={() => {
            void Clipboard.writeText(current.command)
              .then(() => showToast({ type: "success", title: current.title, description: current.description }))
              .catch((error: unknown) => showToast({ type: "error", title: "Could not copy update command", description: error instanceof Error ? error.message : String(error) }));
          }}
        />
      );
    }
    const allowed = canMaintain(props.environmentKey, props.url, props.bearer);
    return (
      <SettingsButton
        label={current.label}
        disabled={!allowed}
        onPress={() => {
          void (async () => {
            if (!canMaintain(props.environmentKey, props.url, props.bearer)) return;
            if (current.confirm && !(await confirm(current.confirm))) return;
            await runServerUpdate({ key: props.environmentKey, serverLabel: props.serverLabel, selfUpdate: caps().selfUpdate, targetVersion: props.targetVersion, request: props.request, progress: caps().progress, ...(props.subscribe ? { subscribe: props.subscribe } : {}), ...(props.fromVersion ? { fromVersion: props.fromVersion } : {}) });
          })();
        }}
      />
    );
  };
}
