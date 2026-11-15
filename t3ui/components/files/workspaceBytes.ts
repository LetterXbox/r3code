// A workspace file's bytes, read straight from disk (the viewers that parse a file themselves: archives, databases, office
// documents, the full text of a large file). The web app fetches these through a signed asset URL; the native app runs on the
// machine that holds a local workspace, so it reads the path. A remote environment's files are not on this disk.
import { readFile, stat } from "fs/promises";

export function absoluteWorkspacePath(cwd: string, relativePath: string): string {
  if (relativePath.startsWith("/")) return relativePath;
  return `${cwd.replace(/\/+$/, "")}/${relativePath}`;
}

export const FILE_READ_FAILURE = "The file could not be loaded. Close it and try again.";

/** Reads the file, refusing one over `maxBytes` before reading it. */
export async function readWorkspaceBytes(cwd: string, relativePath: string, maxBytes: number): Promise<Uint8Array> {
  const path = absoluteWorkspacePath(cwd, relativePath);
  let size: number;
  try {
    size = Number((await stat(path)).size);
  } catch {
    throw new Error(FILE_READ_FAILURE);
  }
  if (size > maxBytes) throw new Error(`Preview limited to files under ${Math.round(maxBytes / (1024 * 1024))} MB.`);
  try {
    return await readFile(path);
  } catch {
    throw new Error(FILE_READ_FAILURE);
  }
}

/** UTF-8 text of a few bytes for a source preview: the first `limit` bytes, flagged when cut; binary and non-UTF-8 data is refused. */
export function decodePreviewText(bytes: Uint8Array, limit = 1024 * 1024): { text: string; truncated: boolean } {
  const bounded = bytes.subarray(0, limit);
  if (bounded.includes(0)) throw new Error("This file contains binary data and cannot be shown as text.");
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bounded, { stream: bytes.length > limit }), truncated: bytes.length > limit };
  } catch {
    throw new Error("This file is not UTF-8 text. Open it in another app to view its contents.");
  }
}
