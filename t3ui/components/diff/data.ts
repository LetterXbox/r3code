/** A review.getDiffPreview source kind (ReviewDiffPreviewSourceKind). */
export type DiffScope = "branch-range" | "working-tree" | "commit";

export interface ChangedFile {
  /** A second listing of the same change (old path, new path) gets its own identity (DiffPanel's fileKey occurrence). */
  key?: string;
  path: string;
  previousPath: string | null;
  additions: number;
  deletions: number;
}

export interface DiffSource {
  kind: DiffScope;
  /** The source id (a commit's sha for kind "commit"); the per-file request sends it back as commitSha. */
  id: string | null;
  title: string;
  commitSubject: string | null;
  baseRef: string | null;
  headRef: string | null;
  diff: string;
  truncated: boolean;
  files: ChangedFile[] | null;
}

export interface DiffPreview {
  source: DiffSource | null;
  incomplete: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function readDiffPreview(value: unknown, scope: DiffScope): DiffPreview {
  if (!object(value) || !Array.isArray(value.sources)) throw new Error("The server returned an invalid diff preview.");
  const candidate = value.sources.find((item) => object(item) && item.kind === scope);
  if (candidate === undefined) {
    if (value.sources.length > 0) throw new Error("This diff scope is not available from the server.");
    return { source: null, incomplete: value.incomplete === true };
  }
  if (!object(candidate) || typeof candidate.diff !== "string" || typeof candidate.title !== "string") {
    throw new Error("The server returned an invalid diff source.");
  }
  let files: ChangedFile[] | null = null;
  if (candidate.files !== undefined) {
    if (!Array.isArray(candidate.files)) throw new Error("The server returned an invalid changed-files list.");
    files = candidate.files.map((file) => {
      if (!object(file) || typeof file.path !== "string" || !file.path ||
          typeof file.additions !== "number" || !Number.isFinite(file.additions) ||
          typeof file.deletions !== "number" || !Number.isFinite(file.deletions) ||
          (file.previousPath !== null && typeof file.previousPath !== "string")) {
        throw new Error("The server returned an invalid changed file.");
      }
      return { path: file.path, previousPath: file.previousPath, additions: file.additions, deletions: file.deletions };
    });
  }
  return { source: { kind: scope, id: nullableString(candidate.id), title: candidate.title, commitSubject: nullableString(candidate.commitSubject), baseRef: nullableString(candidate.baseRef), headRef: nullableString(candidate.headRef), diff: candidate.diff, truncated: candidate.truncated === true, files }, incomplete: value.incomplete === true };
}

/** The file's identity in the panel: its path, or its occurrence key when the same change is listed again. */
export const fileKeyOf = (file: Pick<ChangedFile, "key" | "path">): string => file.key ?? file.path;

/** DiffPanel's pathOccurrences: a change listed again ([previous path, path] seen before) gets `${pathKey}:${n}`. */
export function withOccurrenceKeys<File extends ChangedFile>(files: readonly File[]): File[] {
  const seen = new Map<string, number>();
  return files.map((file) => {
    const pathKey = JSON.stringify([file.previousPath ?? file.path, file.path]);
    const occurrence = seen.get(pathKey) ?? 0;
    seen.set(pathKey, occurrence + 1);
    return occurrence === 0 ? file : { ...file, key: `${pathKey}:${occurrence}` };
  });
}
