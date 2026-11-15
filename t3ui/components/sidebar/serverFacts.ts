// Server facts the thread menu needs and the store does not keep: the scratch workspace root
// (which makes a "No project" thread eligible for Turn into project) and the environment id a
// thread link names. Read once per connection through server.getConfig.
import { signal } from "nsh";
import { backendConnectionGeneration, backendStatus, backendUrl, requestBackend } from "../../store";

interface Facts {
  scratchRoot: string | null;
  autoSettleOptOut: boolean;
  projectFromScratch: boolean;
  environmentId: string | null;
}

const NONE: Facts = { scratchRoot: null, autoSettleOptOut: false, projectFromScratch: false, environmentId: null };
const facts = signal<Facts>(NONE);
let loadedKey = "";
/** The endpoint whose server.getConfig has answered at least once (the web's `serverConfigs.has(environmentId)`). */
const configuredUrl = signal("");

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

/** Reads the facts out of a server.getConfig reply. */
export function factsFromConfig(config: unknown): Facts {
  const root = record(config);
  const environment = record(root?.environment);
  const capabilities = record(environment?.capabilities);
  return {
    scratchRoot: typeof root?.scratchWorkspaceRoot === "string" && root.scratchWorkspaceRoot.length > 0 ? root.scratchWorkspaceRoot : null,
    autoSettleOptOut: capabilities?.threadAutoSettleOptOut === true,
    projectFromScratch: capabilities?.threadProjectFromScratch === true,
    environmentId: typeof environment?.environmentId === "string" && environment.environmentId.length > 0 ? environment.environmentId : null,
  };
}

function load() {
  if (backendStatus() !== "connected") return;
  const key = `${backendUrl()}|${backendConnectionGeneration()}`;
  if (key === loadedKey) return;
  loadedKey = key;
  facts.set(NONE);
  void requestBackend("server.getConfig", {}).then((config) => {
    if (loadedKey === key) {
      facts.set(factsFromConfig(config));
      configuredUrl.set(backendUrl());
    }
  }).catch(() => {
    if (loadedKey === key) loadedKey = "";
  });
}

/**
 * Whether the server config is in: until then a thread is not classified Snoozed or Settled, so a shelf
 * never flashes with rows the server has not confirmed (`configLoaded && settledOverride === "settled"`).
 * Without a connection there is no config to wait for, so the cached rows keep their sections.
 */
export function configLoaded(): boolean {
  load();
  return backendStatus() !== "connected" || configuredUrl() === backendUrl();
}

export function supportsAutoSettleOptOut(): boolean {
  load();
  return facts().autoSettleOptOut;
}

export function supportsProjectFromScratch(): boolean {
  load();
  return facts().projectFromScratch;
}

/** The server's scratch workspace root: the folder of the "No project" project. */
export function scratchWorkspaceRoot(): string | null {
  load();
  return facts().scratchRoot;
}

export function environmentId(): string | null {
  load();
  return facts().environmentId;
}

const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

/** A project is the scratch one when its folder is the server's scratch workspace root. */
export function isScratchProjectPath(projectPath: string | undefined, root: string | null): boolean {
  return Boolean(projectPath) && root !== null && trimSlash(projectPath!) === trimSlash(root);
}

/** Whether the thread can become its own project: a scratch thread with a folder of its own, on a server that can. */
export function canTurnThreadIntoProject(thread: { path?: string }, projectPath: string | undefined): boolean {
  return Boolean(thread.path) && supportsProjectFromScratch() && isScratchProjectPath(projectPath, facts().scratchRoot);
}

/** The link Copy > Thread puts on the clipboard (hostedThreadLink in shared/threadLinks.ts). */
export function hostedThreadLink(environment: string, threadId: string, origin = "https://app.t3.codes"): string {
  const segment = (value: string) => encodeURIComponent(value).replace(/[.!~*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return new URL(`/threads/${segment(environment)}/${segment(threadId)}`, origin).toString();
}
