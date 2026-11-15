// useFileMetadata.ts + client-runtime fileMetadata.ts: what the server knows about a path a chip names (kind, size, MIME
// type), asked with filesystem.getMetadata for absolute, non-network paths up to 512 chars, only with filesystem:read.
// Answers are cached per path; invalidateFileMetadata drops the paths a turn changed (FileMetadataThreadProvider).
import { effect, signal, untracked } from "nsh";
import { openThread, requestBackend, threadCheckpoints } from "../../store";
import { currentWorkspace } from "../rightPanel/panelState";
import { linkMetadataPath } from "../terminal/terminalLinks";
import { filesystemReadAccess } from "./fileAccess";

export interface FileMetadataEntry { kind: "file" | "directory" | string; byteLength?: number; mimeType?: string }

const cache = new Map<string, ReturnType<typeof signal<FileMetadataEntry | null>>>();
const inFlight = new Set<string>();
// client-runtime fileMetadata.ts METADATA_STALE_TIME_MS: an answer, a miss and a failure alike are asked again after a minute
// (agents mention paths before they exist), here on the next read once the answer is stale.
const STALE_MS = 60_000;
const expires = new Map<string, number>();
let now = () => Date.now();

function parseEntry(result: unknown): FileMetadataEntry | null {
  const entries = typeof result === "object" && result !== null ? (result as { entries?: unknown }).entries : null;
  const entry = Array.isArray(entries) ? entries[0] : null;
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.kind !== "string") return null;
  return {
    kind: record.kind,
    ...(typeof record.byteLength === "number" ? { byteLength: record.byteLength } : {}),
    ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}),
  };
}

function load(path: string, slot: ReturnType<typeof signal<FileMetadataEntry | null>>) {
  if (inFlight.has(path)) return;
  inFlight.add(path);
  expires.set(path, now() + STALE_MS);
  void requestBackend("filesystem.getMetadata", { paths: [path] })
    .then((result) => { if (cache.get(path) === slot) slot.set(parseEntry(result)); })
    .catch(() => undefined)
    .finally(() => { inFlight.delete(path); if (cache.get(path) === slot) expires.set(path, now() + STALE_MS); });
}

/** The metadata for `path` (resolved against `cwd`), null until (or unless) the server answers. Reactive. */
export function fileMetadata(path: string, cwd: string | null | undefined): FileMetadataEntry | null {
  // getFileMetadataQueryAtom: without a cwd a relative path stays relative, so it is not asked about.
  if (!cwd && !path.startsWith("/") && !path.startsWith("~/")) return null;
  const target = linkMetadataPath(path, cwd ?? "/");
  if (target === null || !filesystemReadAccess().canReadFiles) return null;
  let slot = cache.get(target);
  if (!slot) { slot = signal<FileMetadataEntry | null>(null); cache.set(target, slot); load(target, slot); }
  else if (now() >= (expires.get(target) ?? 0)) load(target, slot);
  return slot() ?? null;
}

/** Drops cached answers for these absolute paths so the next read asks again. */
export function invalidateFileMetadata(paths: Iterable<string>) {
  for (const path of paths) {
    const slot = cache.get(path);
    if (!slot) continue;
    cache.delete(path);
    expires.delete(path);
    slot.set(null);
  }
}

/** projectsWriteFile onSuccess: the written file's cached metadata (size, kind) is stale, under the path it was sent and the one the server resolved. */
export function invalidateWrittenFile(cwd: string, ...relativePaths: readonly (string | undefined)[]) {
  const keys = relativePaths.flatMap((path) => (path ? [linkMetadataPath(path, cwd)] : []));
  invalidateFileMetadata(keys.filter((key): key is string => key !== null));
}

/** FileMetadataThreadProvider: the absolute paths of files whose checkpoint entries changed between two checkpoint lists. */
export function changedCheckpointPaths(
  before: readonly { id: string; status?: unknown; files: readonly { path: string }[] }[],
  after: readonly { id: string; status?: unknown; files: readonly { path: string }[] }[],
  cwd: string,
): string[] {
  const resolve = (path: string) => (path.startsWith("/") ? path : `${cwd.replace(/\/+$/, "")}/${path.replace(/^(\.\/)+/, "")}`);
  const oldById = new Map(before.map((checkpoint) => [checkpoint.id, checkpoint]));
  const paths = new Set<string>();
  for (const checkpoint of after) {
    const old = oldById.get(checkpoint.id);
    oldById.delete(checkpoint.id);
    if (old?.files === checkpoint.files && old?.status === checkpoint.status) continue;
    for (const file of checkpoint.files) paths.add(resolve(file.path));
    for (const file of old?.files ?? []) paths.add(resolve(file.path));
  }
  for (const checkpoint of oldById.values()) for (const file of checkpoint.files) paths.add(resolve(file.path));
  return [...paths];
}

type CheckpointShape = { id: string; status?: unknown; files: readonly { path: string }[] };
const checkpointShapes = (records: readonly Record<string, unknown>[]): CheckpointShape[] => records.flatMap((record) => {
  if (typeof record.id !== "string") return [];
  const files = Array.isArray(record.files) ? record.files.flatMap((file) => (typeof file === "object" && file !== null && typeof (file as { path?: unknown }).path === "string" ? [{ path: (file as { path: string }).path }] : [])) : [];
  return [{ id: record.id, status: record.status, files: record.files === undefined ? [] : files }];
});

let installed = false;
/** FileMetadataThreadProvider: when the open thread's checkpoints change, the files they touched are asked again. */
export function installFileMetadataInvalidation() {
  if (installed) return;
  installed = true;
  let previous: { threadId: string | null; cwd: string; records: readonly Record<string, unknown>[]; shapes: CheckpointShape[] } | null = null;
  effect(() => {
    const records = threadCheckpoints();
    const cwd = currentWorkspace()?.cwd ?? null;
    const threadId = openThread()?.id ?? null;
    untracked(() => {
      if (!cwd) { previous = null; return; }
      const before = previous;
      // Unchanged records keep their identity, so a file list compares by reference as the reference does.
      const shapes = records.map((record, index) => {
        const old = before?.records.indexOf(record) ?? -1;
        return old >= 0 ? before!.shapes[old]! : checkpointShapes([record])[0] ?? { id: String(index), files: [] };
      });
      previous = { threadId, cwd, records, shapes };
      if (!before || before.cwd !== cwd || before.threadId !== threadId) return;
      const paths = changedCheckpointPaths(before.shapes, shapes, cwd);
      if (paths.length > 0) invalidateFileMetadata(paths);
    });
  });
}

/** Tests. */
export function resetFileMetadataForTest(clock?: () => number) { cache.clear(); inFlight.clear(); expires.clear(); now = clock ?? (() => Date.now()); }
