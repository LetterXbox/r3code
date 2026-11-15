// lib/addProjectToMachine.ts and the clone URL helpers (packages/shared/src/cloneUrl.ts): clone a project onto another
// connected machine with projectClone.start, wait for subscribeProjectClones to report it done, then relay the chosen
// ignored files (projects.readFile on the source, projects.writeFile on the target). The two servers never talk.
import { signal } from "nsh";
import { record } from "../backend/client";

export type CloneProtocol = "ssh" | "https";
const SCP_LIKE_URL = /^(?:[^@/\s]+@)?(\[[^\]@/\s]+\]|[^:/\s[\]]+):(?!\/)(.+)$/;
const SSH_URL = /^ssh:\/\/(?:[^/\s]*@)?(\[[^\]@/\s]+\]|[^@:/\s]+)(:\d+)?\/(.+)$/;
const HTTPS_URL = /^https?:\/\/(?:[^/\s]*@)?(\[[^\]@/\s]+\]|[^@:/\s]+)(:\d+)?\/(.+)$/;

function parseCloneUrl(url: string): { protocol: CloneProtocol; host: string; path: string; customPort: boolean } | null {
  const trimmed = url.trim();
  const ssh = SSH_URL.exec(trimmed);
  if (ssh) return { protocol: "ssh", host: ssh[1]!, path: ssh[3]!, customPort: !!ssh[2] };
  const https = HTTPS_URL.exec(trimmed);
  if (https) return { protocol: "https", host: https[1]!, path: https[3]!, customPort: !!https[2] };
  const scp = SCP_LIKE_URL.exec(trimmed);
  if (scp) return { protocol: "ssh", host: scp[1]!, path: scp[2]!, customPort: false };
  return null;
}

export function cloneUrlProtocol(url: string): CloneProtocol | null {
  return parseCloneUrl(url)?.protocol ?? null;
}

export function cloneUrlForProtocol(url: string, protocol: CloneProtocol): string | null {
  const parsed = parseCloneUrl(url);
  if (!parsed) return null;
  if (parsed.protocol === protocol) return url.trim();
  if (parsed.customPort) return null;
  if (parsed.protocol === "ssh" && parsed.host.toLowerCase() === "ssh.dev.azure.com") {
    const azure = /^v3\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)$/.exec(parsed.path);
    return azure ? `https://dev.azure.com/${azure[1]}/${azure[2]}/_git/${azure[3]}` : null;
  }
  if (parsed.protocol === "https" && parsed.host.toLowerCase() === "dev.azure.com") {
    const azure = /^([^/?#]+)\/([^/?#]+)\/_git\/([^/?#]+)$/.exec(parsed.path);
    return azure ? `git@ssh.dev.azure.com:v3/${azure[1]}/${azure[2]}/${azure[3]}` : null;
  }
  return protocol === "ssh" ? `git@${parsed.host}:${parsed.path}` : `https://${parsed.host}/${parsed.path}`;
}

/** Matches the server's read cap: a larger file would arrive truncated. */
export const COPYABLE_FILE_MAX_BYTES = 1024 * 1024;
const DEFAULT_COPIED_FILE_NAME = /^(?:\.env(?:\..+)?|\.envrc|\.dev\.vars)$/;
export function isDefaultCopiedFile(path: string): boolean {
  const name = path.split("/").at(-1) ?? path;
  return DEFAULT_COPIED_FILE_NAME.test(name);
}

export interface IgnoredFile { path: string; byteLength: number }
export function defaultSelection(files: readonly IgnoredFile[]): Set<string> {
  return new Set(files.filter((file) => file.byteLength <= COPYABLE_FILE_MAX_BYTES && isDefaultCopiedFile(file.path)).map((file) => file.path));
}

/** A project rooted below its repository top keeps copied files at the same path below the clone. */
export function projectSubdirectory(repositoryRoot: string | undefined, workspaceRoot: string): string {
  if (!repositoryRoot) return "";
  const prefix = repositoryRoot.replace(/[\\/]+$/, "");
  const rest = workspaceRoot.slice(prefix.length);
  return workspaceRoot.startsWith(prefix) && /^[\\/]/.test(rest) ? rest.slice(1).replaceAll("\\", "/") : "";
}

export type Request = (method: string, payload: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
export type Subscribe = (method: string, payload: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void) => () => void;

export interface AddProjectToMachineInput {
  source: { request: Request; cwd: string };
  subdirectory: string;
  target: { request: Request; subscribe: Subscribe; label: string; key: string };
  projectId: string;
  title: string;
  remoteUrl: string;
  destinationPath: string;
  files: string[];
}

export type ProjectFileCopy = { phase: "copying" } | { phase: "failed"; title: string; failures: string[] };
/** Ignored-file copies still owed to a cloned project, by "<target key>:<projectId>". */
export const projectFileCopies = signal<Record<string, ProjectFileCopy>>({});
function setFileCopy(key: string, copy: ProjectFileCopy | null) {
  projectFileCopies.update((all) => { const next = { ...all }; if (copy) next[key] = copy; else delete next[key]; return next; });
}

const message = (error: unknown) => (error instanceof Error ? error.message : "An error occurred.");

/** Resolves with the done clone, or null once the clone is removed; a failed clone keeps waiting (the composer retries). */
function waitForClone(subscribe: Subscribe, projectId: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let seen = false;
    let settled = false;
    let stop: (() => void) | null = null;
    const finish = (value: Record<string, unknown> | null) => { if (settled) return; settled = true; stop?.(); resolve(value); };
    stop = subscribe("subscribeProjectClones", {}, (event) => {
      // ProjectCloneListEvent: the whole list of clone snapshots each time.
      if (!Array.isArray(event)) return;
      const clone = event.map(record).find((item) => item?.projectId === projectId) ?? null;
      if (clone) seen = true;
      if (clone?.phase === "done") finish(clone);
      else if (!clone && seen) finish(null);
    }, () => finish(null));
    if (settled) stop();
  });
}

/** Resolves once the clone starts; the file relay continues in the background. */
export async function addProjectToMachine(input: AddProjectToMachineInput): Promise<void> {
  const reads = await Promise.all(input.files.map(async (relativePath) => {
    try {
      const result = record(await input.source.request("projects.readFile", { cwd: input.source.cwd, relativePath }));
      if (result?.truncated === true) return { relativePath, error: "Too large to copy." };
      return { relativePath, contents: typeof result?.contents === "string" ? result.contents : "" };
    } catch (error) {
      return { relativePath, error: message(error) };
    }
  }));
  const copyKey = `${input.target.key}:${input.projectId}`;
  if (reads.length > 0) setFileCopy(copyKey, { phase: "copying" });
  let started: Record<string, unknown> | null;
  try {
    started = record(await input.target.request("projectClone.start", {
      projectId: input.projectId, title: input.title, createdAt: new Date().toISOString(), remoteUrl: input.remoteUrl, destinationPath: input.destinationPath,
    }, { timeoutMs: 60000 }));
  } catch (error) {
    setFileCopy(copyKey, null);
    throw new Error(message(error));
  }
  if (reads.length === 0) return;
  void (async () => {
    const clone = await waitForClone(input.target.subscribe, input.projectId);
    if (!clone) { setFileCopy(copyKey, null); return; }
    const cwd = typeof started?.cwd === "string" ? started.cwd : typeof clone.destinationPath === "string" ? clone.destinationPath : input.destinationPath;
    const failed: string[] = [];
    for (const read of reads) {
      if (!("contents" in read)) { failed.push(`${read.relativePath}: ${read.error}`); continue; }
      try {
        await input.target.request("projects.writeFile", {
          cwd, relativePath: input.subdirectory ? `${input.subdirectory}/${read.relativePath}` : read.relativePath, contents: read.contents,
        });
      } catch (error) {
        failed.push(`${read.relativePath}: ${message(error)}`);
      }
    }
    setFileCopy(copyKey, failed.length === 0 ? null : {
      phase: "failed", title: `Could not copy ${failed.length} ${failed.length === 1 ? "file" : "files"} to ${input.target.label}`, failures: failed,
    });
  })();
}
