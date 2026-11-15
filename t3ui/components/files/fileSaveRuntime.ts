// The save sessions wired to the connection: `projects.writeFile` for the write, the session's `filesystem:write` scope
// (AuthFilesystemWriteScope, read the way usagePriceTargets reads settings:write) for who may write.
import { signal, untracked } from "nsh";
import { fetchSessionGrant, parseSessionGrant, sessionGrantsScope } from "../../backend/providers";
import { backendBearer, backendConnectionGeneration, backendStatus, backendUrl, requestBackend } from "../../store";
import { invalidateWrittenFile } from "./fileMetadata";
import { createFileSaveSessions, type FileSaveTarget } from "./fileSave";

const FILESYSTEM_WRITE = "filesystem:write";

/** Whether this session may write files; `unknown` until the session is read. */
const access = signal<"unknown" | "writable" | "readonly">("unknown");
export const filesystemAccess = () => access();
const writableListeners = new Set<() => void>();
function setAccess(value: "unknown" | "writable" | "readonly") {
  const regained = value === "writable" && access() !== "writable";
  access.set(value);
  if (regained) for (const listener of [...writableListeners]) listener();
}
/** Tests (and fixtures with no server behind them) decide the access directly. */
export function setFilesystemAccessForTest(value: "unknown" | "writable" | "readonly") { setAccess(value); }

let readFor = "";
/** Reads the session's scopes (once per connection); call it from an effect that tracks the connection. */
export function refreshFilesystemAccess() {
  const connected = backendStatus() === "connected";
  const generation = backendConnectionGeneration();
  const url = backendUrl();
  const bearer = backendBearer();
  if (!connected || !bearer) return;
  const key = `${url}\u0000${generation}`;
  if (readFor === key) return;
  readFor = key;
  untracked(() => {
    void fetchSessionGrant(url, bearer).then((session) => {
      if (!session) { readFor = ""; return; }
      setAccess(sessionGrantsScope(parseSessionGrant(session) ?? { authenticated: false }, FILESYSTEM_WRITE) ? "writable" : "readonly");
    }).catch(() => { readFor = ""; });
  });
}

/** Edits the server has not taken yet, by file: kept while write access is missing and written when it returns. */
const unsaved = new Map<string, string>();
/** Bumped on every change to `unsaved`, so surfaces reading a draft follow it (the optimistic file atom's subscribers). */
const unsavedVersion = signal(0);
const keyOf = (target: FileSaveTarget) => `${target.cwd}\u0000${target.relativePath}`;

/** resolveProjectFileQueryData / getOptimisticProjectFileQueryData: the draft a surface shows over the file's read,
 * or null when every edit has been written. Every surface on the file reads the same draft. */
export function unsavedDraft(target: FileSaveTarget): string | null {
  void unsavedVersion();
  return unsaved.get(keyOf(target)) ?? null;
}

let writer: (method: string, payload: unknown) => Promise<unknown> = requestBackend;
/** Fixtures with no server behind them send the writes elsewhere; null restores the connection. */
export function setFileSaveWriter(next: ((method: string, payload: unknown) => Promise<unknown>) | null) { writer = next ?? requestBackend; }

export function createRuntimeSaveSessions(write: (method: string, payload: unknown) => Promise<unknown> = (method, payload) => writer(method, payload)) {
  return createFileSaveSessions({
    debounceMs: 500,
    canPersist: () => access() === "writable",
    subscribeWritable: (_target, onWritable) => {
      writableListeners.add(onWritable);
      return () => { writableListeners.delete(onWritable); };
    },
    persist: async (target, contents) => {
      try {
        const result = await write("projects.writeFile", { cwd: target.cwd, relativePath: target.relativePath, contents });
        const written = typeof result === "object" && result !== null ? (result as { relativePath?: unknown }).relativePath : undefined;
        invalidateWrittenFile(target.cwd, target.relativePath, typeof written === "string" ? written : undefined);
        return true;
      } catch {
        return false;
      }
    },
    confirm: (target, contents) => {
      // Another editor holds newer contents: the write is confirmed but the draft is not clean.
      if (unsaved.get(keyOf(target)) !== contents) return false;
      unsaved.delete(keyOf(target));
      unsavedVersion.update((value) => value + 1);
      return true;
    },
    readUnsaved: (target) => unsaved.get(keyOf(target)) ?? null,
  });
}

export const fileSaveSessions = createRuntimeSaveSessions();

/** Notes an edit the session will write (or keep until it can). */
export function noteUnsavedEdit(target: FileSaveTarget, contents: string) {
  unsaved.set(keyOf(target), contents);
  unsavedVersion.update((value) => value + 1);
  fileSaveSessions.change(target, contents);
}
