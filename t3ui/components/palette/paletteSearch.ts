// The palette's server-backed lookups, ported from CommandPaletteLookups / ProjectFilePicker /
// ProjectContentSearchDialog / useThreadSearch: file names (projects.searchEntries), file contents
// (projects.searchContents) and message text (orchestration.searchThreads). Results arrive late, so
// each lookup carries a sequence number and a stale answer is dropped.
import { signal } from "nsh";
import { parseMatchRanges, type MatchRange } from "./highlightedSearchLine";

export interface FileHit { path: string }
export interface ContentHit { path: string; lineNumber: number; lineContent: string; matchRanges?: MatchRange[] }
export interface MessageHit { threadId: string; source: string; snippet: string; messageCreatedAt: string | null; messageId?: string | null }

type Request = (method: string, payload: unknown) => Promise<unknown>;

// ProjectFilePicker PROJECT_FILE_PICKER_RESULT_LIMIT and queries.ts PROJECT_CONTENT_SEARCH_LIMIT (the contract's maxima).
export const FILE_LIMIT = 200;
export const CONTENT_LIMIT = 500;
export const MESSAGE_SEARCH_MIN = 2;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** useProjectPathSearch: the query is cut to the contract's 256 characters, never in the middle of a surrogate pair. */
export function clampPathQuery(query: string): string {
  return query.trim().slice(0, 256).replace(/[\uD800-\uDBFF]$/, "");
}

export function parseFileHits(value: unknown): { files: FileHit[]; truncated: boolean } {
  const v = record(value);
  if (!v || !Array.isArray(v.entries)) throw new Error("The server returned invalid file results.");
  return {
    files: v.entries.flatMap((entry) => {
      const e = record(entry);
      return e && typeof e.path === "string" && e.kind !== "directory" ? [{ path: e.path }] : [];
    }),
    truncated: v.truncated === true,
  };
}

export function parseContentHits(value: unknown): { matches: ContentHit[]; truncated: boolean; invalidRegex: boolean } {
  const v = record(value);
  if (!v || !Array.isArray(v.matches)) throw new Error("The server returned invalid search results.");
  return {
    matches: v.matches.flatMap((raw) => {
      const m = record(raw);
      return m && typeof m.path === "string" && typeof m.lineNumber === "number" && typeof m.lineContent === "string"
        ? [{ path: m.path, lineNumber: m.lineNumber, lineContent: m.lineContent, matchRanges: parseMatchRanges(m.matchRanges) }] : [];
    }),
    truncated: v.truncated === true,
    invalidRegex: typeof v.regexFallbackError === "string" && v.regexFallbackError.length > 0,
  };
}

export function parseMessageHits(value: unknown): MessageHit[] {
  const v = record(value);
  if (!v || !Array.isArray(v.matches)) throw new Error("The environment returned invalid search results.");
  return v.matches.flatMap((raw) => {
    const m = record(raw);
    return m && typeof m.threadId === "string" && typeof m.snippet === "string"
      ? [{ threadId: m.threadId, source: typeof m.source === "string" ? m.source : "user", snippet: m.snippet, messageCreatedAt: typeof m.messageCreatedAt === "string" ? m.messageCreatedAt : null, messageId: typeof m.messageId === "string" ? m.messageId : null }]
      : [];
  });
}

export function contentSummary(matches: readonly ContentHit[], truncated: boolean): string {
  const files = new Set(matches.map((match) => match.path)).size;
  return `${matches.length.toLocaleString()}${truncated ? "+" : ""} results in ${files.toLocaleString()} files`;
}

export function createPaletteSearch(deps: { request: Request; debounceMs?: number }) {
  const files = signal<FileHit[]>([]);
  const content = signal<ContentHit[]>([]);
  const messages = signal<MessageHit[]>([]);
  const pending = signal(false);
  /** A message search (the root list's) is waiting for the server: the footer says so while the list may still grow. */
  const messagesPending = signal(false);
  const error = signal("");
  const invalidRegex = signal(false);
  const truncated = signal(false);
  const caseSensitive = signal(false);
  const wholeWord = signal(false);
  const useRegex = signal(false);
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function schedule(run: (request: number) => Promise<void>) {
    if (timer) clearTimeout(timer);
    const request = ++sequence;
    timer = setTimeout(() => { void run(request); }, deps.debounceMs ?? 120);
  }

  function reset() {
    sequence++;
    if (timer) clearTimeout(timer);
    files.set([]); content.set([]); messages.set([]); pending.set(false); messagesPending.set(false); error.set(""); invalidRegex.set(false); truncated.set(false);
  }

  function searchFiles(cwd: string, query: string) {
    pending.set(true);
    error.set("");
    schedule(async (request) => {
      try {
        const result = parseFileHits(await deps.request("projects.searchEntries", { cwd, query: clampPathQuery(query), limit: FILE_LIMIT, kind: "file" }));
        if (request !== sequence) return;
        files.set(result.files);
        truncated.set(result.truncated);
      } catch (cause) {
        if (request === sequence) { files.set([]); error.set(cause instanceof Error ? cause.message : String(cause)); }
      } finally {
        if (request === sequence) pending.set(false);
      }
    });
  }

  function searchContent(cwd: string, query: string) {
    if (!query) { reset(); return; }
    pending.set(true);
    error.set("");
    schedule(async (request) => {
      try {
        const result = parseContentHits(await deps.request("projects.searchContents", {
          cwd, query, limit: CONTENT_LIMIT, caseSensitive: caseSensitive(), wholeWord: wholeWord(), useRegex: useRegex(),
        }));
        if (request !== sequence) return;
        content.set(result.matches);
        truncated.set(result.truncated);
        invalidRegex.set(result.invalidRegex);
      } catch (cause) {
        if (request === sequence) { content.set([]); error.set(cause instanceof Error ? cause.message : String(cause)); }
      } finally {
        if (request === sequence) pending.set(false);
      }
    });
  }

  function searchMessages(query: string) {
    const trimmed = query.trim();
    if (trimmed.length < MESSAGE_SEARCH_MIN || trimmed.startsWith(">")) { sequence++; messages.set([]); messagesPending.set(false); return; }
    messagesPending.set(true);
    schedule(async (request) => {
      try {
        const hits = parseMessageHits(await deps.request("orchestration.searchThreads", { query: trimmed.slice(0, 200), limit: 50 }));
        if (request === sequence) messages.set(hits);
      } catch {
        if (request === sequence) messages.set([]);
      } finally {
        if (request === sequence) messagesPending.set(false);
      }
    });
  }

  return { files, content, messages, pending, messagesPending, error, invalidRegex, truncated, caseSensitive, wholeWord, useRegex, reset, searchFiles, searchContent, searchMessages };
}

export type PaletteSearch = ReturnType<typeof createPaletteSearch>;
