// The stacked review (DiffPanel.tsx's code view): every changed file's patch one after the other, in the order the
// server listed them. Files whose patch has not arrived, failed, or has no text stay out of the stack and are
// reported beside it, so the reader sees why a listed file has no diff under it.
import { fileKeyOf, type ChangedFile } from "./data";

export interface FilePatch {
  state: "loading" | "ready" | "error";
  patch: string;
  truncated: boolean;
  error: string;
}

export interface StackedPatch {
  /** The joined patch of every file that has text. */
  text: string;
  /** Paths still being fetched. */
  pending: string[];
  failed: { path: string; key: string; error: string }[];
  /** Paths whose diff has no lines (binary, mode changes, renames without edits). */
  empty: string[];
  /** Paths whose diff the server cut short. */
  truncated: string[];
}

/** A file with no lines: its header still draws, so a file whose patch is loading or failed shows its status in place. */
export const headerOnlyPatch = (path: string): string => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;

export function stackedPatch(files: readonly ChangedFile[], patches: Readonly<Record<string, FilePatch>>, options: { headers?: boolean } = {}): StackedPatch {
  const out: StackedPatch = { text: "", pending: [], failed: [], empty: [], truncated: [] };
  const parts: string[] = [];
  for (const file of files) {
    const entry = patches[fileKeyOf(file)];
    if (entry === undefined || entry.state === "loading") { out.pending.push(file.path); if (options.headers) parts.push(headerOnlyPatch(file.path)); }
    else if (entry.state === "error") { out.failed.push({ path: file.path, key: fileKeyOf(file), error: entry.error }); if (options.headers) parts.push(headerOnlyPatch(file.path)); }
    else {
      if (entry.truncated) out.truncated.push(file.path);
      if (entry.patch.trim() === "") out.empty.push(file.path);
      else parts.push(entry.patch.endsWith("\n") ? entry.patch : `${entry.patch}\n`);
    }
  }
  out.text = parts.join("");
  return out;
}
