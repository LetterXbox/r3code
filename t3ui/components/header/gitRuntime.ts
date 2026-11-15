// The server side of the Git actions row: the live status subscription
// (subscribeVcsStatus), `git.runStackedAction` (a progress stream) and `vcs.pull`.
// Both take their transport as a parameter, so tests drive them without a server.
import { mergeVcsStatus, readVcsStatus, type GitStackedAction, type VcsStatus } from "./gitLogic";

export type Subscribe = (method: string, payload: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void) => () => void;
export type Request = (method: string, payload: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;

/** Streams the cwd's status; `onStatus(null)` until a snapshot arrives. Returns the unsubscribe. */
export function watchVcsStatus(cwd: string, subscribe: Subscribe, onStatus: (status: VcsStatus | null) => void, onError: (message: string) => void): () => void {
  let parts: { local: Record<string, unknown> | null; remote: Record<string, unknown> | null } = { local: null, remote: null };
  onStatus(null);
  return subscribe("subscribeVcsStatus", { cwd, includeRemote: true }, (event) => {
    parts = mergeVcsStatus(parts, event);
    onStatus(readVcsStatus(parts));
  }, (error) => onError(error.message));
}

export interface GitProgress {
  status: string;
  output: string | null;
  startedAtMs: number;
}

export interface GitActionResult {
  title: string;
  description: string | null;
  /** The created or existing change request, when the action opened one. */
  url: string | null;
  /** The action created a change request (`result.pr.status === "created"`): the row reads "Created PR". */
  created?: boolean;
  /** The branch the action created (`resolveThreadBranchUpdate`): the thread follows it. */
  createdBranch?: string | null;
}

const DEFAULT_STATUS = "Starting source control action...";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let serial = 0;

/**
 * Runs a stacked action and reports progress. The stream's normal end arrives
 * as the client's "ended unexpectedly" error, so it only counts as a failure
 * when no `action_finished` event came before it.
 */
export function runGitAction(
  input: { cwd: string; action: GitStackedAction; threadId?: string; projectId?: string; commitMessage?: string; filePaths?: readonly string[]; featureBranch?: boolean },
  subscribe: Subscribe,
  hooks: { onProgress: (progress: GitProgress) => void; onDone: (result: GitActionResult) => void; onFailed: (message: string) => void },
  now: () => number = Date.now,
): () => void {
  const actionId = `t3ui-${Date.now().toString(36)}-${++serial}`;
  let settled = false;
  let status = DEFAULT_STATUS;
  let output: string | null = null;
  let startedAtMs = now();
  const report = () => hooks.onProgress({ status, output, startedAtMs });
  report();
  const stop = subscribe("git.runStackedAction", {
    actionId, cwd: input.cwd, action: input.action,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
    ...(input.filePaths && input.filePaths.length > 0 ? { filePaths: input.filePaths } : {}),
    ...(input.featureBranch ? { featureBranch: true } : {}),
  }, (event) => {
    if (settled || !object(event) || event.actionId !== actionId) return;
    if (event.kind === "phase_started" && typeof event.label === "string") { status = event.label; output = null; startedAtMs = now(); report(); }
    else if (event.kind === "hook_started" && typeof event.hookName === "string") { status = `Running ${event.hookName}...`; startedAtMs = now(); report(); }
    else if (event.kind === "hook_output" && typeof event.text === "string") { output = event.text.trim().split("\n").pop() ?? null; report(); }
    else if (event.kind === "action_finished" && object(event.result)) {
      settled = true;
      const toast = object(event.result.toast) ? event.result.toast : {};
      const cta = object(toast.cta) ? toast.cta : {};
      const created = object(event.result.pr) && event.result.pr.status === "created";
      const branch = object(event.result.branch) && event.result.branch.status === "created" && typeof event.result.branch.name === "string" && event.result.branch.name ? event.result.branch.name : null;
      hooks.onDone({
        created,
        createdBranch: branch,
        title: typeof toast.title === "string" ? toast.title : "Done",
        description: typeof toast.description === "string" ? toast.description : null,
        url: cta.kind === "open_pr" && typeof cta.url === "string" ? cta.url : null,
      });
    } else if (event.kind === "action_failed") {
      settled = true;
      hooks.onFailed(typeof event.message === "string" ? event.message : "Git action failed");
    }
  }, (error) => {
    if (settled) return;
    settled = true;
    hooks.onFailed(error.message);
  });
  return () => { settled = true; stop(); };
}

/** `vcs.pull`: the quick action's Pull. */
export async function runPull(cwd: string, request: Request): Promise<GitActionResult> {
  const result = await request("vcs.pull", { cwd });
  if (!object(result)) throw new Error("The server returned an invalid pull result.");
  const pulled = result.status === "pulled";
  const ref = typeof result.refName === "string" ? result.refName : "the branch";
  const upstream = typeof result.upstreamRef === "string" ? result.upstreamRef : "upstream";
  return { title: pulled ? "Pulled" : "Already up to date", description: pulled ? `Updated ${ref} from ${upstream}` : `${ref} is already synchronized.`, url: null };
}

/** `shell.openInEditor`: the Open in picker's launch (LaunchEditorInput). */
export function openInEditor(cwd: string, editor: string, request: Request): Promise<unknown> {
  return request("shell.openInEditor", { cwd, editor });
}

/** `vcs.listRefs`: the branch picker's rows. */
export async function listRefs(cwd: string, request: Request, query?: string): Promise<{ name: string; isRemote?: boolean; remoteName?: string; current: boolean }[]> {
  const result = await request("vcs.listRefs", { cwd, ...(query ? { query } : {}), limit: 100 });
  const refs = object(result) && Array.isArray(result.refs) ? result.refs : [];
  return refs.flatMap((ref) => {
    if (!object(ref) || typeof ref.name !== "string") return [];
    return [{ name: ref.name, current: ref.current === true, ...(ref.isRemote === true ? { isRemote: true } : {}), ...(typeof ref.remoteName === "string" ? { remoteName: ref.remoteName } : {}) }];
  });
}

/** `vcs.switchRef`: checks out a branch; resolves with the branch name the server settled on. */
export async function switchRef(cwd: string, refName: string, request: Request): Promise<string | null> {
  const result = await request("vcs.switchRef", { cwd, refName });
  return object(result) && typeof result.refName === "string" ? result.refName : null;
}
