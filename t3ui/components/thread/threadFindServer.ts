// useThreadFind.ts useServerResults: on a server that searches a whole thread (ServerConfig.threadFind), the bar asks
// `orchestration.searchThread` (100 ms debounce) instead of scanning the loaded rows, so matches in history the client
// has not loaded count too. The result names the active match (entryId = a message's messageId or a plan's item id),
// the total, and whether the server is still counting. Next / previous re-ask from the active match with an offset.
import { signal } from "nsh";

export interface ServerFindMatch { entryId: string; runId: string | null; occurrence: number }
export interface ServerFindResult { totalMatches: number; activeIndex: number; match: ServerFindMatch | null; complete: boolean }
export interface ServerFindStart { entryId: string; occurrence: number }

type Request = (method: string, payload: unknown) => Promise<unknown>;

export function readServerFindResult(value: unknown): ServerFindResult | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.totalMatches !== "number" || typeof v.activeIndex !== "number") return null;
  const m = v.match as Record<string, unknown> | null | undefined;
  const match = m && typeof m.entryId === "string" && typeof m.occurrence === "number"
    ? { entryId: m.entryId, runId: typeof m.runId === "string" ? m.runId : null, occurrence: m.occurrence } : null;
  return { totalMatches: v.totalMatches, activeIndex: v.activeIndex, match, complete: v.complete !== false };
}

/** The timeline row ids a server entry can be: a message row, or a plan (an activity row). */
export function rowIdsForEntry(entryId: string): string[] {
  return [`message:${entryId}`, `activity:${entryId}`];
}

/** The find start a viewport row gives (readThreadFindPosition): its entry id and the first occurrence. */
export function startForRow(rowId: string | null): ServerFindStart | undefined {
  if (!rowId) return undefined;
  const match = /^(?:message|activity):(.+)$/.exec(rowId);
  return match ? { entryId: match[1]!, occurrence: 0 } : undefined;
}

/** The bar's count label (ThreadFindBar): "Searching…", "Search failed", "1/…" while counting, else "n/total". */
export function serverFindLabel(input: { query: string; status: "loading" | "error" | null; counting: boolean; activeIndex: number; total: number }, format: (index: number, total: number) => string): string {
  if (input.status === "loading") return "Searching…";
  if (input.status === "error") return "Search failed";
  if (!input.query.trim()) return "";
  return input.counting ? "1/…" : format(input.activeIndex, input.total);
}

type FindSubscribe = (method: string, payload: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void) => () => void;

/** useThreadFind.ts: with ServerConfig.threadFindProgressive the web reads `orchestration.searchThreadStream` (partial answers
 * until one is `complete`), otherwise `orchestration.searchThread`. */
export function createServerThreadFind(deps: { request: Request; debounceMs?: number; subscribe?: FindSubscribe; progressive?: () => boolean }) {
  let stopStream: (() => void) | null = null;
  const endStream = () => { const stop = stopStream; stopStream = null; stop?.(); };
  const result = signal<ServerFindResult | null>(null);
  const status = signal<"loading" | "error" | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let last: { threadId: string; query: string; start?: ServerFindStart; offset?: number } | null = null;

  const run = (input: { threadId: string; query: string; start?: ServerFindStart; offset?: number }, loading: boolean) => {
    last = input;
    const mine = ++generation;
    if (loading) status.set("loading");
    endStream();
    const payload = {
      threadId: input.threadId, query: input.query,
      ...(input.start ? { start: input.start } : {}), ...(input.offset ? { offset: input.offset } : {}),
    };
    if (deps.subscribe && deps.progressive?.()) {
      let done = false;
      const stop = deps.subscribe("orchestration.searchThreadStream", payload, (value) => {
        if (mine !== generation || done) return;
        const parsed = readServerFindResult(value);
        if (!parsed) { status.set("error"); return; }
        result.set(parsed);
        if (parsed.complete) { done = true; status.set(null); if (stopStream === stop) endStream(); }
      }, () => { if (mine === generation && !done) status.set("error"); });
      if (done) stop(); else stopStream = stop;
      return;
    }
    void deps.request("orchestration.searchThread", payload).then((value) => {
      if (mine !== generation) return;
      const parsed = readServerFindResult(value);
      if (!parsed) { status.set("error"); return; }
      result.set(parsed);
      status.set(null);
    }, () => { if (mine === generation) status.set("error"); });
  };

  return {
    result,
    status,
    /** A new query: debounced, starting at `start` (the viewport's first row). */
    search(threadId: string, query: string, start?: ServerFindStart) {
      clearTimeout(timer);
      generation++;
      const trimmed = query.trim().slice(0, 200);
      result.set(null);
      if (!trimmed) { status.set(null); last = null; return; }
      status.set("loading");
      timer = setTimeout(() => run({ threadId, query: trimmed, ...(start ? { start } : {}) }, true), deps.debounceMs ?? 100);
    },
    /** Next (+1) or previous (-1): ask again from the active match. */
    step(threadId: string, query: string, delta: number) {
      const current = result();
      if (!current || current.totalMatches === 0 || !current.complete) return;
      const start = current.match ? { entryId: current.match.entryId, occurrence: current.match.occurrence } : undefined;
      run({ threadId, query: query.trim(), ...(start ? { start } : {}), offset: delta }, false);
    },
    retry() { if (last) run(last, true); },
    reset() { clearTimeout(timer); generation++; endStream(); result.set(null); status.set(null); last = null; },
  };
}
