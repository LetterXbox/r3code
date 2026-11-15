// State of the Code tab: the paged diff, viewed marks and the fold / layout toolbar.
import { effect, signal, untracked } from "nsh";
import { showToast } from "../toast";
import {
  fetchPullRequestDiff, filterPatch, ignoreWhitespacePatch, isFileViewed, isTestFile, isStaleViewed, patchFiles, viewedCount, viewedRange, viewedStates,
  type DiffFetchDeps, type DiffPage, type PullRequestRefInput, type ViewedState,
} from "./pullRequestDiff.logic";
import { orderPatchSlices } from "./pullRequestFileOrder.logic";
import { hideTestFiles } from "./pullRequestCodePrefs";

export type DiffLayoutChoice = "unified" | "split";

/** PullRequestCodeTab's page merge: a refetched page at `index` (page 0 is the first, cursorless one) that answers the
 * same as the loaded one keeps every page; a changed one replaces it and drops the later pages, whose cursors target
 * the old diff. A page past the end is appended. Returns the same array when nothing changed. */
export function mergeDiffPage(pages: readonly DiffPage[], index: number, page: DiffPage): readonly DiffPage[] {
  if (index >= pages.length) return [...pages, page];
  const existing = pages[index]!;
  const same = existing.patch === page.patch && existing.truncated === page.truncated && existing.nextCursor === page.nextCursor
    && existing.omitted.length === page.omitted.length
    && existing.omitted.every((file, at) => { const next = page.omitted[at]; return next !== undefined && next.path === file.path && next.additions === file.additions && next.deletions === file.deletions; });
  if (same) return pages;
  return [...pages.slice(0, index), page];
}

export function createPullRequestCodeModel(deps: {
  request: (method: string, payload: unknown) => Promise<unknown>;
  ref: () => PullRequestRefInput | null;
  /** The tab is showing; the diff is fetched lazily on first show. */
  active: () => boolean;
  http: DiffFetchDeps;
  /** The commits of the pull request, for the diff scope (null until the activity is read): a selected commit no longer among them reads as "All commits". */
  commits?: () => readonly { oid: string }[] | null;
  /** capabilities.viewedFiles: who keeps the viewed ticks; absent, the host cannot record views. */
  viewedFiles?: () => "host" | "environment" | undefined;
  /** "Hide whitespace changes" starts from the diff settings. */
  initialIgnoreWhitespace?: () => boolean;
  initialWrap?: () => boolean;
  /** The detail's updatedAt: a new revision of the same pull request clears the loaded pages and refetches the first
   * one and the viewed ticks (PullRequestDetailPanel's refreshToken). */
  revision?: () => string | null;
  /** PullRequestDetailPanel's backgroundRefreshToken (usePullRequestTurnRefresh: the environment's refresh stream):
   * each new value refetches the first page and the viewed ticks, keeping the loaded pages. */
  backgroundToken?: () => number;
}) {
  const pages = signal<DiffPage[]>([]);
  const status = signal<"idle" | "loading" | "loaded" | "error">("idle");
  const error = signal("");
  const layout = signal<DiffLayoutChoice>("unified");
  const hideTests = hideTestFiles;
  /** The commit the diff is scoped to; null is "All commits". */
  const selectedCommit = signal<string | null>(null);
  const ignoreWhitespace = signal(deps.initialIgnoreWhitespace?.() ?? false);
  const wrap = signal(deps.initialWrap?.() ?? false);
  /** A file the Guide or the timeline sent the reader to: it stays visible among hidden test files and pages in until it loads. */
  const reveal = signal<{ path: string; nonce: number } | null>(null);
  let revealNonce = 0;
  const requestReveal = (path: string) => reveal.set({ path, nonce: ++revealNonce });
  const viewedTruncated = signal(false);
  const commit = () => {
    const oid = selectedCommit();
    if (oid === null) return null;
    const known = deps.commits?.() ?? null;
    return known === null || known.some((entry) => entry.oid === oid) ? oid : null;
  };
  const states = signal<Map<string, ViewedState> | null>(null);
  const overlay = signal<Map<string, boolean>>(new Map());
  const viewedError = signal("");
  let anchor: string | null = null;
  let sequence = 0;
  let loadedKey = "";
  /** The pull request and commit the diff shows: it changes when the reader moves on, and what was open or half written there goes. */
  const scopeKey = signal("");

  const keyOf = (ref: PullRequestRefInput) => `${ref.projectId}|${ref.host ?? ""}|${ref.repository}|${ref.number}|${commit() ?? ""}`;

  async function loadFirst() {
    const ref = deps.ref();
    const request = ++sequence;
    if (!ref) { pages.set([]); status.set("idle"); return; }
    loadedKey = keyOf(ref);
    scopeKey.set(loadedKey);
    pages.set([]);
    status.set("loading");
    error.set("");
    try {
      const page = await fetchPullRequestDiff(deps.http, ref, { ...(commit() ? { commit: commit()! } : {}) });
      if (request !== sequence) return;
      pages.set([page]);
      status.set("loaded");
    } catch (cause) {
      if (request !== sequence) return;
      error.set(cause instanceof Error ? cause.message : String(cause));
      status.set("error");
    }
    void loadViewed(request);
  }

  async function loadViewed(request: number) {
    const ref = deps.ref();
    if (!ref) return;
    try {
      const response = await deps.request("pullRequests.filesViewed", ref);
      const result = viewedStates(response);
      if (request !== sequence) return;
      viewedTruncated.set(typeof response === "object" && response !== null && (response as { truncated?: unknown }).truncated === true);
      states.set(result);
      overlay.set(new Map());
      viewedError.set("");
    } catch (cause) {
      if (request === sequence) viewedError.set(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function loadMore() {
    const ref = deps.ref();
    const last = pages()[pages().length - 1];
    if (!ref || !last?.nextCursor || status() === "loading") return;
    const request = sequence;
    status.set("loading");
    try {
      const page = await fetchPullRequestDiff(deps.http, ref, { cursor: last.nextCursor, ...(commit() ? { commit: commit()! } : {}) });
      if (request !== sequence) return;
      pages.update((all) => [...all, page]);
      status.set("loaded");
    } catch (cause) {
      if (request !== sequence) return;
      error.set(cause instanceof Error ? cause.message : String(cause));
      status.set("error");
    }
  }

  let baseKey = "";
  effect(() => {
    const ref = deps.ref();
    const active = deps.active();
    // Another pull request starts from "All commits".
    const base = ref ? `${ref.projectId}|${ref.host ?? ""}|${ref.repository}|${ref.number}` : "";
    if (base !== baseKey) { baseKey = base; if (selectedCommit() !== null) selectedCommit.set(null); }
    if (ref && active && keyOf(ref) !== loadedKey) void loadFirst();
    if (!ref) { loadedKey = ""; sequence++; pages.set([]); status.set("idle"); states.set(null); overlay.set(new Map()); }
  });

  // refreshToken: a later revision of the pull request the tab already showed reloads it from the first page.
  let revisionBase = "";
  let lastRevision: string | null = null;
  effect(() => {
    const revision = deps.revision?.() ?? null;
    const ref = deps.ref();
    if (!ref || revision === null) return;
    const base = `${ref.projectId}|${ref.host ?? ""}|${ref.repository}|${ref.number}`;
    if (base !== revisionBase) { revisionBase = base; lastRevision = revision; return; }
    if (revision === lastRevision) return;
    lastRevision = revision;
    untracked(() => { if (deps.active() && loadedKey !== "") void loadFirst(); else loadedKey = ""; });
  });

  /** backgroundRefreshToken: refetches the first page and the viewed ticks while keeping the loaded pages (and so the
   * scroll); the page merge drops what changed. */
  async function backgroundRefresh() {
    const ref = deps.ref();
    if (!ref || pages().length === 0) return;
    const request = sequence;
    try {
      const page = await fetchPullRequestDiff(deps.http, ref, { ...(commit() ? { commit: commit()! } : {}) });
      if (request !== sequence) return;
      const merged = mergeDiffPage(pages(), 0, page);
      if (merged !== pages()) pages.set([...merged]);
    } catch {
      // A failed background read keeps what is shown, as the query keeps its last answer.
    }
    void loadViewed(request);
  }

  /** createPullRequestDiffFileContentsLoader: one file's two texts at the diff's scope (pullRequests.diffFileContents),
   * for the unchanged lines between and around its hunks. */
  function diffFileContents(input: { changeType: string; oldPath: string; newPath: string }): Promise<unknown> {
    const ref = deps.ref();
    if (!ref) return Promise.reject(new Error("Diff file contents are unavailable for this selection."));
    return deps.request("pullRequests.diffFileContents", { ...ref, ...(commit() ? { commit: commit()! } : {}), ...input });
  }

  let appliedBackgroundToken: number | null = null;
  effect(() => {
    const token = deps.backgroundToken?.() ?? null;
    if (token === null) return;
    const previous = appliedBackgroundToken;
    appliedBackgroundToken = token;
    if (previous !== null && previous !== token) untracked(() => void backgroundRefresh());
  });

  /** The pages as one patch in the order the tab lists files, with whitespace-only changes folded away when asked. */
  const allPatch = () => {
    const ordered = orderPatchSlices(pages().map((page) => page.patch));
    return ignoreWhitespace() ? ignoreWhitespacePatch(ordered) : ordered;
  };
  const hiddenTestFiles = () => (hideTests() ? patchFiles(allPatch()).filter((file) => isTestFile(file.path) && file.path !== reveal()?.path).length : 0);
  const testFileCount = () => patchFiles(allPatch()).filter((file) => isTestFile(file.path)).length;
  const patch = () => (hideTests() ? filterPatch(allPatch(), (path) => path === reveal()?.path || !isTestFile(path)) : allPatch());
  const files = () => patchFiles(patch());
  const nextCursor = () => pages()[pages().length - 1]?.nextCursor ?? null;
  const omitted = () => pages().flatMap((page) => page.omitted);
  /** The host withheld part of the diff: a slice with content omitted. */
  const withheld = () => pages().some((page) => page.truncated);
  const viewedEnabled = () => deps.viewedFiles?.() !== undefined;
  const viewedStore = () => deps.viewedFiles?.();
  /** The viewed ticks could not be read, so the boxes show whatever was last read. */
  const hasPages = () => pages().length > 0;
  const isViewed = (path: string) => isFileViewed(path, states(), overlay());
  const isStale = (path: string) => isStaleViewed(path, states(), overlay());
  const viewed = () => viewedCount(files().map((file) => file.path), states(), overlay());

  let writesInFlight = 0;
  async function setViewed(path: string, value: boolean, extendRange = false): Promise<string[]> {
    const ref = deps.ref();
    if (!ref) return [];
    const paths = extendRange ? viewedRange(files().map((file) => file.path), path, anchor) : [path];
    anchor = path;
    const batch = paths.map((entry) => ({ path: entry, viewed: value }));
    overlay.update((all) => { const next = new Map(all); for (const entry of batch) next.set(entry.path, value); return next; });
    writesInFlight++;
    try {
      await deps.request("pullRequests.setFilesViewed", { ...ref, files: batch });
      viewedError.set("");
    } catch (cause) {
      overlay.update((all) => { const next = new Map(all); for (const entry of batch) if (next.get(entry.path) === value) next.delete(entry.path); return next; });
      // filesViewedStore reportFailure: the tick goes back and a toast says so.
      void cause;
      showToast({ type: "error", title: "Could not update viewed files" });
    } finally {
      // filesViewedStore: after a write (answered or refused) the host's reading is asked again; with more presses still on
      // their way the last one asks, so its overlay is not cleared under them.
      writesInFlight--;
      if (writesInFlight === 0) void loadViewed(sequence);
    }
    return paths;
  }

  /** The files a press (or a shift-press, extending from the last one pressed) marks. */
  const rangeFor = (path: string, extendRange: boolean) => (extendRange ? viewedRange(files().map((file) => file.path), path, anchor) : [path]);

  return { scopeKey, rangeFor, reveal, requestReveal, testFileCount, commit, selectedCommit, ignoreWhitespace, wrap, viewedTruncated, withheld, viewedEnabled, viewedStore, hasPages, pages, status, error, layout, hideTests, hiddenTestFiles, patch, files, nextCursor, omitted, isViewed, isStale, viewed, setViewed, viewedError, loadMore, reload: loadFirst, backgroundRefresh, diffFileContents };
}

export type PullRequestCodeModel = ReturnType<typeof createPullRequestCodeModel>;
