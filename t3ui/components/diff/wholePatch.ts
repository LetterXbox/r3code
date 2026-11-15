// A whole multi-file patch (a turn's checkpoint diff, a tool call's recorded patch) split into the panel's per-file
// rows, and lib/toolCallDiff.ts's reconstruction of a provider's recorded file change into a renderable patch.
import { fileKeyOf, withOccurrenceKeys, type ChangedFile } from "./data";
import type { FilePatch } from "./stacked";

function unquote(path: string): string {
  if (path.startsWith("\"") && path.endsWith("\"")) {
    try { return JSON.parse(path) as string; } catch { return path.slice(1, -1); }
  }
  return path;
}

function stripPrefix(path: string): string {
  const plain = unquote(path.trim());
  return plain.replace(/^[ab]\//u, "");
}

function gitHeaderPaths(line: string): { oldPath: string; newPath: string } | null {
  const rest = line.slice("diff --git ".length);
  const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/u.exec(rest);
  if (quoted) return { oldPath: stripPrefix(quoted[1]!), newPath: stripPrefix(quoted[2]!) };
  const plain = /^a\/(.+?) b\/(.+)$/u.exec(rest);
  return plain ? { oldPath: plain[1]!, newPath: plain[2]! } : null;
}

export interface SplitPatch { files: ChangedFile[]; patches: Record<string, FilePatch> }

/** One row per file of a unified patch, in patch order, each with its own patch text and counted lines. */
export function splitWholePatch(patch: string, truncated = false): SplitPatch {
  const found: { file: ChangedFile; patch: string }[] = [];
  let current: { file: ChangedFile; lines: string[]; inHunk: boolean; deleted: boolean } | null = null;
  const flush = () => {
    if (!current) return;
    const text = current.lines.join("\n");
    found.push({ file: current.file, patch: text.endsWith("\n") ? text : `${text}\n` });
    current = null;
  };
  const lines = patch.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const startsGit = line.startsWith("diff --git ");
    const startsBare = !startsGit && line.startsWith("--- ") && (current === null || current.inHunk) && lines[index + 1]?.startsWith("+++ ") === true;
    if (startsGit || startsBare) {
      flush();
      let oldPath = "";
      let newPath = "";
      if (startsGit) {
        const paths = gitHeaderPaths(line);
        oldPath = paths?.oldPath ?? "";
        newPath = paths?.newPath ?? "";
      } else {
        oldPath = stripPrefix(line.slice(4));
        newPath = stripPrefix(lines[index + 1]!.slice(4));
      }
      current = { file: { path: newPath && newPath !== "/dev/null" ? newPath : oldPath, previousPath: null, additions: 0, deletions: 0 }, lines: [line], inHunk: false, deleted: false };
      if (oldPath && newPath && oldPath !== newPath && oldPath !== "/dev/null" && newPath !== "/dev/null") current.file.previousPath = oldPath;
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (!current.inHunk) {
      if (line.startsWith("+++ ")) {
        const target = stripPrefix(line.slice(4));
        if (target === "/dev/null" || line.slice(4).trim() === "/dev/null") current.deleted = true;
        else if (target) current.file.path = target;
      } else if (line.startsWith("--- ") && current.file.path === "") {
        current.file.path = stripPrefix(line.slice(4));
      } else if (line.startsWith("rename from ")) {
        current.file.previousPath = line.slice("rename from ".length);
      }
      if (line.startsWith("@@ ")) current.inHunk = true;
      continue;
    }
    if (line.startsWith("@@ ")) continue;
    if (line.startsWith("+")) current.file.additions++;
    else if (line.startsWith("-")) current.file.deletions++;
  }
  // A deleted file is named by its old path (its "+++" is /dev/null).
  flush();
  // A file the patch lists twice keeps both sections, the second under its occurrence key (withOccurrenceKeys).
  const kept = found.filter((entry) => entry.file.path !== "" && entry.file.path !== "/dev/null");
  const files = withOccurrenceKeys(kept.map((entry) => entry.file));
  const patches: Record<string, FilePatch> = {};
  files.forEach((file, index) => { patches[fileKeyOf(file)] = { state: "ready", patch: kept[index]!.patch, truncated, error: "" }; });
  return { files, patches };
}

// ---- lib/toolCallDiff.ts ----

type Rec = Record<string, unknown>;
interface RecordedChange { path: string; oldPath?: string; operation?: string }

const TRUNCATION_SUFFIX = "\n… output truncated for transport";

function recordedText(value: unknown): { text: string | undefined; truncated: boolean } {
  if (typeof value !== "string") return { text: undefined, truncated: false };
  const truncated = value.endsWith(TRUNCATION_SUFFIX);
  return { text: truncated ? value.slice(0, -TRUNCATION_SUFFIX.length) : value, truncated };
}

function changesOf(item: Rec): RecordedChange[] {
  return Array.isArray(item.changes) ? item.changes.flatMap((value) => {
    const change = value as Rec | null;
    if (!change || typeof change.path !== "string") return [];
    return [{ path: change.path, ...(typeof change.oldPath === "string" ? { oldPath: change.oldPath } : {}), ...(typeof change.operation === "string" ? { operation: change.operation } : {}) }];
  }) : [];
}

function toolCallPatch(diffStr: string | undefined, fileName: string, changes: readonly RecordedChange[]): string | undefined {
  let patch = diffStr;
  if (!patch) return patch;
  const change = changes[0];
  const rawFileOperation = change?.operation === "add" || change?.operation === "delete";
  if (patch.startsWith("diff --git ") || patch.startsWith("--- ")) {
    if (!rawFileOperation) return patch;
    const split = splitWholePatch(patch);
    const complete = split.files.length > 0 && split.files.every((file) => {
      const text = split.patches[file.path]?.patch ?? "";
      const path = file.path.replaceAll("\\", "/");
      return /^@@ /mu.test(text) && changes.some((recorded) => {
        const recordedPath = recorded.path.replaceAll("\\", "/");
        return (recorded.operation === "add" ? file.deletions === 0 : recorded.operation === "delete" ? file.additions === 0 : true) &&
          (recordedPath === path || recordedPath.endsWith(`/${path}`));
      });
    });
    if (complete) return patch;
  }
  // Codex can record added/deleted file contents or bare hunks instead of a complete patch.
  if (rawFileOperation || !patch.trimStart().startsWith("@@ ")) {
    if (!rawFileOperation) return patch;
    const lines = patch.split("\n");
    const hasFinalNewline = patch.endsWith("\n");
    if (hasFinalNewline) lines.pop();
    const added = change!.operation === "add";
    const range = `1,${lines.length}`;
    patch = `@@ -${added ? "0,0" : range} +${added ? range : "0,0"} @@\n${lines.map((line) => `${added ? "+" : "-"}${line}`).join("\n")}\n${hasFinalNewline ? "" : "\\ No newline at end of file\n"}`;
  }
  const oldPath = change?.oldPath ?? fileName;
  const newPath = change?.path ?? fileName;
  const before = change?.operation === "add" ? "/dev/null" : JSON.stringify(`a/${oldPath}`);
  const after = change?.operation === "delete" ? "/dev/null" : JSON.stringify(`b/${newPath}`);
  return `diff --git ${JSON.stringify(`a/${oldPath}`)} ${JSON.stringify(`b/${newPath}`)}\n--- ${before}\n+++ ${after}\n${patch.trimStart()}`;
}

export interface ToolCallPreview { patch: string | undefined; content: { label: string; text: string }[]; truncated: boolean; recordedFileCount: number }

/** toolCallDiff: a `file_change` turn item's patch, or the recorded before/after content when it has no diff. */
export function toolCallDiff(item: Rec): ToolCallPreview {
  const changes = changesOf(item);
  const diff = recordedText(item.diffStr);
  const operation = changes[0]?.operation;
  const emptyContent = diff.text === "" ? "" : undefined;
  const before = recordedText(item.oldStr ?? (operation === "delete" ? emptyContent : undefined));
  const after = recordedText(item.newStr ?? (operation === "add" ? emptyContent : undefined));
  const fileName = typeof item.fileName === "string" ? item.fileName : "";
  return {
    patch: toolCallPatch(diff.text, fileName, changes),
    content: diff.text?.trim()
      ? []
      : [
          { label: "Recorded content before", text: before.text },
          { label: "Recorded content after", text: after.text },
        ].filter((entry): entry is { label: string; text: string } => entry.text !== undefined),
    truncated: diff.truncated || before.truncated || after.truncated,
    recordedFileCount: changes.length,
  };
}
