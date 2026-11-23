import { batch, Clipboard, colorScheme, computed, effect, Image, keymap, List, Overlay, Scroll, signal, Storage, Text, token, untracked, View } from "nsh";
import { showAnchoredCopyErrorToast, showAnchoredCopySuccessToast, type ToastAnchor } from "../toast/anchoredToast";
import { createStableRows } from "../stableRows";
import { HEADER_ICON, headerChangeType, headerPreviousPath, RENAME_ARROW, type HeaderChangeType } from "./fileHeaderKind";
import type { ListRef, ViewRef } from "nsh";
import { DiffView, Input, Menu, MenuItem, Submenu, Tooltip } from "nsh/base";
import type { DiffLineRange, DiffViewRef } from "nsh/base";
import { scaledFor, surfaceZoomTarget } from "../../shell/surfaceZoom";
import { HIcon } from "../header/HeaderIcons";
import { openThread, openThreadTurnItems, requestBackend, settingValue, threadCheckpoints, updateSetting } from "../../store";
import { turnItemDetailRevision } from "../thread/timeline/turnItemDetail";
import type { TurnItem } from "../thread/timeline/turnItemDetail";
import { applyDiffOpenSelection, collapsedFileKeysFor, diffSelectionFor, selectBranchBaseRef, updateCollapsedFileKeys, reconcileTurnSelection, liveToolCallRevision as liveToolCallRevisionFor, selectCommit, selectGitScope, selectTurn, turnDiffSummaries, type DiffPanelSelection } from "./diffPanelStore";
import { splitWholePatch, toolCallDiff, type ToolCallPreview } from "./wholePatch";
import { openFileAction } from "../rightPanel/panelState";
import { showFileMenu } from "../files/fileActionsRuntime";
import { resolveDiffPathForWorkspace } from "./diffFileActions";
import { formatRelativeTimeLabel } from "../palette/paletteLogic";
import { asTimestampFormat, formatShortTimestamp } from "../thread/timestampFormat";
import { createLiveResize } from "../rightPanel/liveResize";
import { attachedExtraContexts, attachExtraContext, detachExtraContext, type ExtraContextRecord } from "../composer/contextChips";
import { commentAnnotations, restoreDiffComments, reviewCommentRecord, type DiffComment } from "./diffComments";
import { clampTreeWidth, readSavedTreeWidth, treeWidthFor } from "./treeWidth";
import { fileKeyOf, readDiffPreview, withOccurrenceKeys, type ChangedFile, type DiffScope, type DiffSource } from "./data";
import { compactCount, diffTreeRows, directoryIds, fileStatus, statusMark, totalStat, type DiffTreeRow } from "./diffTree";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { isTestChangedFile } from "./changedFileKind";
import { buildBaseRefChoices, filterBaseRefChoices, parseBaseRefs, valueForBaseRefChoice, type BaseVcsRef } from "./baseRefChoices";
import { stackedPatch, type FilePatch } from "./stacked";
import { ChevronTurn } from "../motion/Motion";
import { diffAdditionClass, diffColorSchemeIsBlueOrange, diffDeletionClass, diffViewColorClasses } from "./diffColorScheme";
import { MENU_ITEM_ROW_CLASS, MENU_POPUP_CLASS, MENU_SUBPOPUP_CLASS } from "../menuStyles";
import { useLiveRefresh, useWorkspaceMutationRefresh } from "../coordinators/liveRefresh";
import { canHydrateContext, diffChangeType, readDiffFileContents } from "./diffContext";
import { createDiffContextState } from "./diffContextState";
import { DiffContextSeparator } from "./DiffContextSeparator";
import { filesystemReadAccess } from "../files/fileAccess";
import { DiffFindBar, createDiffFindState } from "./DiffFindBar";
import { countInPatch, locateMatch } from "./diffSearch";
import { registerCommand } from "../../commands/registry";
import { openThread as openThreadForRefresh, workspaceMutationId } from "../../store";

export interface DiffPanelProps {
  threadId: string;
  cwd: string | null;
  onClose?: () => void;
  request?: (method: string, payload: unknown) => Promise<unknown>;
  /** The thread's checkpoints (projection.checkpoints); the open thread's from the store by default. */
  checkpoints?: () => readonly Record<string, unknown>[];
  /** Whether the host's files may be read (useFilesystemReadAccess's canReadFiles): gates expanding unchanged context. */
  canReadFiles?: () => boolean;
}


type LoadState = "idle" | "loading" | "ready" | "error";

/** "Hide test files" and the file tree's open state outlive the panel (useHideTestFiles, DIFF_FILE_TREE_STORAGE_KEY). */
const hideTestFiles = signal(false);
const fileTreeOpen = signal(false);
let togglesLoaded = false;
function persistToggle(key: string, value: boolean) { void Storage.setItem(key, value ? "true" : "false").catch(() => {}); }
void Promise.all([Storage.getItem("diffHideTestFiles"), Storage.getItem("diffFileTreeOpen")]).then(([tests, tree]) => {
  if (togglesLoaded) return;
  if (tests === "true") hideTestFiles.set(true);
  if (tree === "true") fileTreeOpen.set(true);
}).catch(() => {}).finally(() => { togglesLoaded = true; });
/** The changed-files column's width once the reader has dragged it (DiffPanel's FileExplorerPane storageKey). */
const savedTreeWidth = signal<number | null>(null);
void Storage.getItem("diffFileTreeWidth").then((text) => { if (savedTreeWidth() === null) savedTreeWidth.set(readSavedTreeWidth(text)); }).catch(() => {});
export function setHideTestFiles(value: boolean) { togglesLoaded = true; hideTestFiles.set(value); persistToggle("diffHideTestFiles", value); }
export function setFileTreeOpen(value: boolean) { togglesLoaded = true; fileTreeOpen.set(value); persistToggle("diffFileTreeOpen", value); }

/** How many files are fetched at once while the stack fills (useReviewFilePatches). */
const PATCH_CONCURRENCY = 4;
/** How many files load automatically before the list reports which are visible (useReviewFilePatches' INITIAL_FILE_COUNT). */
const INITIAL_FILE_COUNT = 4;
/** How many files beyond what is visible are loaded ahead of the scroll (its loadNextFiles batch). */
const LOAD_AHEAD = 4;
/** The reference's file order (useReviewFilePatches' filePathCollator, numeric): file2 sorts before file10.
 * `Intl.Collator` is not available in this runtime, so this compares digit runs as numbers by hand. */
function comparePathsNumerically(a: string, b: string): number {
  let ai = 0;
  let bi = 0;
  while (ai < a.length && bi < b.length) {
    const ac = a[ai]!;
    const bc = b[bi]!;
    const aDigit = ac >= "0" && ac <= "9";
    const bDigit = bc >= "0" && bc <= "9";
    if (aDigit && bDigit) {
      let aEnd = ai;
      while (aEnd < a.length && a[aEnd]! >= "0" && a[aEnd]! <= "9") aEnd++;
      let bEnd = bi;
      while (bEnd < b.length && b[bEnd]! >= "0" && b[bEnd]! <= "9") bEnd++;
      const aNum = a.slice(ai, aEnd).replace(/^0+(?=\d)/, "");
      const bNum = b.slice(bi, bEnd).replace(/^0+(?=\d)/, "");
      if (aNum.length !== bNum.length) return aNum.length - bNum.length;
      if (aNum !== bNum) return aNum < bNum ? -1 : 1;
      ai = aEnd;
      bi = bEnd;
      continue;
    }
    const lowerA = ac.toLowerCase();
    const lowerB = bc.toLowerCase();
    if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1;
    ai++;
    bi++;
  }
  return (a.length - ai) - (b.length - bi);
}

/** state/queries.ts useCheckpointDiff: a range from turn 0 is `orchestration.getFullThreadDiff`, any other `orchestration.getTurnDiff`. */
export function turnDiffRequest(threadId: string, fromTurnCount: number, toTurnCount: number, ignoreWhitespace: boolean): [string, Record<string, unknown>] {
  return fromTurnCount === 0
    ? ["orchestration.getFullThreadDiff", { threadId, toTurnCount, ignoreWhitespace }]
    : ["orchestration.getTurnDiff", { threadId, fromTurnCount, toTurnCount, ignoreWhitespace }];
}

export function DiffPanel(props: DiffPanelProps) {
  // The thread's saved selection (diffPanelStore, t3code:diff-panel-state:v1): branch, uncommitted, a commit, a turn or a tool call.
  const storedSelection = (): DiffPanelSelection => diffSelectionFor(props.threadId);
  // resolveToolCallDiffTarget: a tool-call diff follows its live item's detail revision ("live" while it runs,
  // then its updatedAt), so a diff opened on a running edit reloads once the edit finishes.
  const liveToolCallRevision = computed((): string | null => {
    const current = storedSelection();
    if (current.kind !== "tool-call") return null;
    return liveToolCallRevisionFor(current, openThreadTurnItems(), (item) => turnItemDetailRevision(item as unknown as TurnItem));
  }, { equals: (a, b) => a === b });
  const selection = (): DiffPanelSelection => {
    const current = storedSelection();
    const revision = liveToolCallRevision();
    return current.kind === "tool-call" && revision !== null && revision !== current.revision ? { ...current, revision } : current;
  };
  const isGitSelection = () => { const kind = selection().kind; return kind === "branch" || kind === "unstaged" || kind === "commit"; };
  // The review.getDiffPreview source kind a git selection reads; turns and tool calls read their own whole patch.
  const scope = (): DiffScope => { const current = selection(); return current.kind === "unstaged" ? "working-tree" : current.kind === "commit" ? "commit" : "branch-range"; };
  const commitSha = () => { const current = selection(); return current.kind === "commit" ? current.sha : null; };
  const turns = computed(() => turnDiffSummaries((props.checkpoints ?? threadCheckpoints)()));
  const selectedTurn = () => {
    const current = selection();
    if (current.kind !== "turn") return undefined;
    return turns().find((summary) => summary.runId === current.turnId) ?? turns()[0];
  };
  const latestTurn = () => turns()[0];
  // The tool call's recorded patch (toolCallDiff) once orchestration.getTurnItem answers.
  const toolCallPreview = signal<ToolCallPreview | null>(null);
  const source = signal<DiffSource | null>(null);
  const incomplete = signal(false);
  const selected = signal<string | null>(null);
  // Every changed file's own patch, filled in as the requests settle; the stack is these, joined in the server's order.
  const patches = signal<Record<string, FilePatch>>({});
  // What the DiffView below actually renders: a throttled snapshot of `patches`, so a large diff's files
  // arriving one after another coalesce into a handful of document swaps instead of one per file. Without
  // this, every arrival changes the single joined `patch` string DiffView re-parses and re-highlights from
  // scratch, so every already-rendered row flickers (briefly unhighlighted, then highlighted again) for
  // every other file still loading. Small per-row state (the header's "Loading…"/retry/truncated marks)
  // reads `patches` directly below, so those stay responsive.
  const committedPatches = signal<Record<string, FilePatch>>({});
  const wholePatch = signal("");
  const state = signal<LoadState>("idle");
  // The list's mounted state depends on presence, not on each fresh source object.
  const hasReadySource = computed(() => state() === "ready" && source() !== null);
  const hasSourceFiles = computed(() => (source()?.files?.length ?? 0) > 0);
  const error = signal("");
  const wordWrap = signal(settingValue("wordWrap") === true);
  const collapsedDirs = signal<ReadonlySet<string>>(new Set());
  // Files whose diff is folded away (DiffFileCollapseToggle / "Collapse all files" in DiffPanel.tsx).
  // Kept per thread and scope for the session (useDiffPanelSessionStore), so a fold survives a panel switch.
  const collapseScopeKey = () => {
    const current = selection();
    const section = current.kind === "tool-call" ? `tool-call:${current.threadId}:${current.itemId}`
      : current.kind === "turn" ? `turn:${selectedTurn()?.runId ?? current.turnId}`
      : current.kind === "commit" ? `commit:${current.sha}` : current.kind;
    return `${props.threadId}:${section}`;
  };
  const defaultCollapsedFiles = () => defaultCollapsed();
  const collapsedFiles = () => collapsedFileKeysFor(collapseScopeKey(), defaultCollapsedFiles());
  const copied = signal<string | null>(null);
  // Review comments (AnnotatableCodeView): saved ones, and the line range a new one is being written for.
  const comments = signal<readonly DiffComment[]>([]);
  const draftRange = signal<DiffLineRange | null>(null);
  // Which file the draft is on: every row has its own DiffView, so each takes comments (no single-file gate).
  const draftPath = signal<string | null>(null);
  const draftText = signal("");
  const rowWidth = signal(0);
  const treeWidth = () => treeWidthFor(savedTreeWidth(), rowWidth());
  // The drag follows the sidebar's rail (SidebarResizeRail): the handlers sit on the strip, the overlay catches the pointer.
  const treeResize = createLiveResize({
    axis: "x",
    direction: -1,
    size: () => treeWidth(),
    clamp: (value) => clampTreeWidth(value, rowWidth()),
    commit: (value) => { savedTreeWidth.set(value); void Storage.setItem("diffFileTreeWidth", String(value)).catch(() => {}); },
  });
  const scopeMenuOpen = signal(false);
  useOverlayOpen(() => scopeMenuOpen(), "diff scope menu");
  const revalidating = signal(false);
  const refreshing = () => state() === "loading" || revalidating();
  const listRef = signal<ListRef | null>(null);
  // The lowest index the list currently reports visible: revealFile's scroll target, and the anchor a
  // file loading ABOVE the viewport (growing from a header stub into its full diff) must not disturb.
  const firstVisibleIndex = signal(0);
  let generation = 0;
  let revealRequest = 0;
  let lastKey = "";
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  const rpc = props.request ?? requestBackend;
  const canReadFiles = () => (props.canReadFiles ? props.canReadFiles() : filesystemReadAccess().canReadFiles);
  // createGitDiffFileContentsLoader: a git selection's file texts, fetched on the first press of a hunk separator.
  const fileContext = createDiffContextState((key) => {
    const file = untracked(files).find((item) => fileKeyOf(item) === key);
    const current = untracked(source);
    const patch = untracked(committedPatches)[key]?.patch ?? "";
    if (!file || !current || !props.cwd || !untracked(isGitSelection)) return Promise.reject(new Error("Diff file contents are unavailable for this selection."));
    return rpc("review.getDiffFileContents", {
      cwd: props.cwd,
      sourceKind: current.kind,
      changeType: diffChangeType(file, patch),
      baseRef: current.baseRef,
      headRef: current.headRef,
      oldPath: file.previousPath ?? file.path,
      newPath: file.path,
    }).then(readDiffFileContents);
  });

  // Which files are allowed to fetch their patch, and how many are in flight: a large diff never requests
  // every file, only the ones loaded so far plus the next batch, bounded by PATCH_CONCURRENCY at a time.
  // Dropped (cleared to empty) on unmount, on a thread/scope/whitespace switch, and at the start of every
  // reload, so nothing keeps issuing requests once the surface using them is gone or has moved on.
  let pendingQueue: ChangedFile[] = [];
  let queuedPaths = new Set<string>();
  // Reactive (not a plain counter): the footer reads this to show a loading line only while a request is
  // actually in flight, in place of the old "files not yet loaded" count, which stayed on screen (and kept
  // looking like network activity) long after the queue had genuinely gone idle.
  const inFlight = signal(0);

  function dropQueue() {
    pendingQueue = [];
    queuedPaths = new Set();
  }

  // Coalesces `patches` into `committedPatches`: the first commit of a refresh lands immediately (so the
  // first rows show up without delay), every later one is delayed so a burst of file arrivals (concurrent
  // fetches, or many small files resolving close together) becomes one document swap.
  let commitTimer: ReturnType<typeof setTimeout> | undefined;
  let committedOnce = false;
  const COMMIT_THROTTLE_MS = 200;
  function commitPatches(immediate = false) {
    if (immediate || !committedOnce) {
      if (commitTimer !== undefined) { clearTimeout(commitTimer); commitTimer = undefined; }
      committedOnce = true;
      committedPatches.set(patches());
      return;
    }
    if (commitTimer !== undefined) return;
    commitTimer = setTimeout(() => {
      commitTimer = undefined;
      committedPatches.set(patches());
    }, COMMIT_THROTTLE_MS);
  }

  async function loadFile(request: number, cwd: string, selectedScope: DiffScope, ignoreWhitespace: boolean, file: ChangedFile) {
    // Turns and tool calls arrive as one whole patch, already split into every file's row: nothing to fetch.
    if (!untracked(isGitSelection)) return;
    const sha = untracked(commitSha);
    const key = fileKeyOf(file);
    const previous = patches()[key];
    // Only a failed file being retried needs the loading placeholder written: a first load's entry is
    // already treated as "loading" while absent (patchOf/stackedPatch), and a reload re-validating an
    // already-ready file must not drop it to a placeholder first (that is the flash this exists to avoid) —
    // it keeps showing its current patch until the new one lands, and `previous?.patch === loaded.patch`
    // below skips the write entirely when nothing actually changed.
    if (previous?.state === "error") {
      patches.update((all) => ({ ...all, [key]: { state: "loading", patch: "", truncated: false, error: "" } }));
      commitPatches();
    }
    try {
      const response = readDiffPreview(await rpc("review.getDiffPreview", {
        cwd, ...(sha !== null ? { commitSha: sha } : { sourceKind: selectedScope }), ignoreWhitespace,
        file: { path: file.path, previousPath: file.previousPath, sourceKind: selectedScope },
      }), selectedScope);
      if (request !== generation) return;
      if (!response.source) throw new Error("The file diff is no longer available. Refresh the list.");
      const loaded: FilePatch = { state: "ready", patch: response.source.diff, truncated: response.source.truncated || response.incomplete, error: "" };
      // The content did not actually change (a reload of a file nothing touched): skip the write so this
      // file's already-rendered, already-highlighted rows are left completely alone.
      if (previous?.state === "ready" && previous.patch === loaded.patch && previous.truncated === loaded.truncated) return;
      patches.update((all) => ({ ...all, [key]: loaded }));
      commitPatches();
    } catch (cause) {
      if (request !== generation) return;
      patches.update((all) => ({ ...all, [key]: { state: "error", patch: "", truncated: false, error: cause instanceof Error ? cause.message : String(cause) } }));
      commitPatches();
    }
  }

  // Callers decide which files belong in the window (a reload re-enqueues whatever already has a patch,
  // to revalidate it; visibility only ever adds files that do not have one yet).
  function enqueue(candidates: readonly ChangedFile[]) {
    for (const file of candidates) {
      if (queuedPaths.has(fileKeyOf(file))) continue;
      queuedPaths.add(fileKeyOf(file));
      pendingQueue.push(file);
    }
  }

  /** Drains the queue up to PATCH_CONCURRENCY in flight; stops at once if the generation moved on. */
  function pump(request: number, cwd: string, selectedScope: DiffScope, ignoreWhitespace: boolean) {
    while (request === generation && inFlight() < PATCH_CONCURRENCY && pendingQueue.length > 0) {
      const file = pendingQueue.shift();
      if (file === undefined) break;
      queuedPaths.delete(fileKeyOf(file));
      inFlight.update((count) => count + 1);
      void loadFile(request, cwd, selectedScope, ignoreWhitespace, file).finally(() => {
        inFlight.update((count) => count - 1);
        if (request === generation) pump(request, cwd, selectedScope, ignoreWhitespace);
      });
    }
  }

  /** Starts (or restarts) loading: the first INITIAL_FILE_COUNT files as a safety net before the list's
   * own viewability report arrives, or exactly the paths that were already loaded before a reload (so a
   * refresh re-validates what the reader actually scrolled to, which the list's own virtualisation means
   * is not necessarily a prefix of the list). */
  function requestInitial(request: number, cwd: string, selectedScope: DiffScope, ignoreWhitespace: boolean, files: readonly ChangedFile[], keepPaths: ReadonlySet<string> | null) {
    dropQueue();
    enqueue(keepPaths ? files.filter((file) => keepPaths.has(fileKeyOf(file))) : files.slice(0, INITIAL_FILE_COUNT));
    pump(request, cwd, selectedScope, ignoreWhitespace);
  }

  /** The list reported which files are on screen (List's onViewableItemsChange): load those, plus a
   * short lookahead past the last one, which is what fills a short diff whose whole content already fits
   * the viewport without the reader ever scrolling, and what keeps scrolling ahead of the reader. */
  function requestVisible(cwd: string | null, visible: readonly ChangedFile[], highestIndex: number) {
    if (!cwd) return;
    const needed = visible.filter((file) => patches()[fileKeyOf(file)] === undefined);
    const lookahead = shownFiles().slice(highestIndex + 1, highestIndex + 1 + LOAD_AHEAD).filter((file) => patches()[fileKeyOf(file)] === undefined);
    if (needed.length === 0 && lookahead.length === 0) return;
    enqueue([...needed, ...lookahead]);
    pump(generation, cwd, scope(), ignoreWhitespace());
  }

  async function refresh(threadId: string, cwd: string, selectedScope: DiffScope, ignoreWhitespace: boolean) {
    const request = ++generation;
    const current = untracked(selection);
    const turn = untracked(selectedTurn);
    const identity = current.kind === "commit" ? `commit:${current.sha}:${current.baseRef ?? ""}` : current.kind === "branch" ? `branch:${current.baseRef ?? ""}` : current.kind === "turn" ? `turn:${turn?.runId ?? ""}` : current.kind === "tool-call" ? `tool-call:${current.itemId}` : selectedScope;
    const key = `${threadId}\0${cwd}\0${identity}\0${ignoreWhitespace}`;
    // A genuinely new context (first open, a switch of scope/thread/whitespace mode) starts clean: those
    // paths mean nothing here. A reload of the SAME context (the refresh button, a VCS status update)
    // keeps every existing patch in place; `loadFile` above only overwrites a path once its content
    // actually differs, so a file nobody touched never flashes while the rest of the diff reloads.
    const isReload = key === lastKey;
    const keepVisible = isReload && state() === "ready" && source() !== null;
    const previousSelected = isReload ? selected() : null;
    lastKey = key;
    revalidating.set(keepVisible);
    if (!keepVisible) state.set("loading");
    if (!isReload) {
      patches.set({});
      committedPatches.set({});
      committedOnce = false;
      measuredHeights.set({});
      fileContext.reset();
      wholePatch.set("");
    }
    error.set("");
    if (current.kind === "turn" || current.kind === "tool-call") {
      try { await refreshWhole(request, threadId, current, turn, ignoreWhitespace, keepVisible); }
      finally { if (request === generation) revalidating.set(false); }
      return;
    }
    toolCallPreview.set(null);
    try {
      const sha = current.kind === "commit" ? current.sha : null;
      const baseRef = current.kind === "branch" || current.kind === "commit" ? current.baseRef : null;
      const result = readDiffPreview(await rpc("review.getDiffPreview", {
        cwd, ...(baseRef ? { baseRef } : {}), ...(sha !== null ? { commitSha: sha } : { sourceKind: selectedScope }), ignoreWhitespace, metadataOnly: true,
      }), selectedScope);
      if (request !== generation) return;
      batch(() => {
        source.set(result.source);
        incomplete.set(result.incomplete);
        selected.set(previousSelected);
      });
      if (!result.source) {
        state.set("ready");
        return;
      }
      const files = result.source.files;
      if (!files) wholePatch.set(result.source.diff);
      else {
        // Exactly which paths the reader had already loaded (wherever in the list they are: visibility
        // can load a middle file without the ones above it), so a reload re-validates those, not a prefix.
        const keepPaths = isReload ? new Set(Object.keys(patches())) : null;
        if (isReload) {
          // Drop patches for files no longer in this reload's list; leave every other path untouched.
          const keep = new Set(files.map(fileKeyOf));
          patches.update((all) => {
            let changed = false;
            const next: Record<string, FilePatch> = {};
            for (const [path, patch] of Object.entries(all)) {
              if (keep.has(path)) next[path] = patch; else changed = true;
            }
            return changed ? next : all;
          });
          commitPatches(true);
        }
        requestInitial(request, cwd, selectedScope, ignoreWhitespace, files, keepPaths);
      }
      state.set("ready");
    } catch (cause) {
      if (request !== generation) return;
      if (!keepVisible) source.set(null);
      error.set(cause instanceof Error ? cause.message : String(cause));
      if (!keepVisible) state.set("error");
    } finally {
      if (request === generation) revalidating.set(false);
    }
  }

  /** A turn (orchestration.getTurnDiff over its checkpoint range) or a tool call (orchestration.getTurnItem's
   * file_change, through toolCallDiff): one whole patch, split here into the same per-file rows. */
  async function refreshWhole(request: number, threadId: string, current: DiffPanelSelection, turn: ReturnType<typeof selectedTurn>, ignoreWhitespace: boolean, keepVisible: boolean) {
    dropQueue();
    try {
      let patch = "";
      let truncated = false;
      if (current.kind === "turn") {
        toolCallPreview.set(null);
        if (!turn) { source.set(null); state.set("ready"); return; }
        const result = await rpc(...turnDiffRequest(threadId, Math.max(0, turn.checkpointTurnCount - 1), turn.checkpointTurnCount, ignoreWhitespace));
        if (request !== generation) return;
        const diff = (result as { diff?: unknown } | null)?.diff;
        if (typeof diff !== "string") throw new Error("The server returned an invalid turn diff.");
        patch = diff;
      } else if (current.kind === "tool-call") {
        const result = await rpc("orchestration.getTurnItem", { threadId: current.threadId, itemId: current.itemId, ...(current.revision ? { revision: current.revision } : {}) });
        if (request !== generation) return;
        const item = (result as { item?: Record<string, unknown> } | null)?.item;
        const preview = item?.type === "file_change" ? toolCallDiff(item) : null;
        toolCallPreview.set(preview);
        patch = preview?.patch ?? "";
        truncated = preview?.truncated === true;
      }
      const split = splitWholePatch(patch, truncated);
      batch(() => {
        source.set({ kind: "branch-range", id: null, title: current.kind === "turn" ? `Turn ${turn?.checkpointTurnCount ?? "?"}` : "Tool call", commitSubject: null, baseRef: null, headRef: null, diff: patch, truncated, files: split.files });
        incomplete.set(false);
        patches.set(split.patches);
        commitPatches(true);
      });
      state.set("ready");
      // "Open diff" on a changed file: the turn opens scrolled to it (selectTurn's filePath / revealRequestId).
      if (current.kind === "turn" && current.filePath) {
        const target = split.files.find((file) => file.path === current.filePath || file.path.endsWith(`/${current.filePath}`));
        if (target) setTimeout(() => { if (request === generation) revealFile(target); }, 0);
      }
    } catch (cause) {
      if (request !== generation) return;
      if (!keepVisible) source.set(null);
      error.set(cause instanceof Error ? cause.message : String(cause));
      if (!keepVisible) state.set("error");
    }
  }

  // Opening the diff (or switching thread while it is open) without an explicit request shows the branch scope.
  effect(() => { const threadId = props.threadId; untracked(() => applyDiffOpenSelection(threadId)); });

  // A selected turn that disappeared moves to the latest (reconcileTurnSelection).
  effect(() => {
    if (selection().kind !== "turn") return;
    reconcileTurnSelection(props.threadId, turns().map((summary) => summary.runId));
  });

  effect(() => {
    const threadId = props.threadId;
    const cwd = props.cwd;
    void selection();
    void selectedTurn()?.runId;
    const selectedScope = scope();
    const ignoreWhitespace = settingValue("diffIgnoreWhitespace") === true;
    if (!cwd && untracked(isGitSelection)) {
      generation++;
      dropQueue();
      revalidating.set(false);
      source.set(null);
      state.set("idle");
    } else {
      void untracked(() => refresh(threadId, cwd ?? "", selectedScope, ignoreWhitespace));
    }
    // Unmount, or a switch of thread, scope or whitespace mode: no further request for this generation
    // can be issued (pump/loadFile both check `request === generation`), and the queue itself is dropped
    // so nothing already in it lingers.
    return () => { generation++; dropQueue(); };
  });

  /** `key`: the file's identity (fileKeyOf), its path unless the same change is listed again. */
  function retryFile(key: string) {
    const cwd = props.cwd;
    const file = files().find((item) => fileKeyOf(item) === key);
    if (cwd && file) void loadFile(generation, cwd, scope(), settingValue("diffIgnoreWhitespace") === true, file);
  }

  // CodeViewSearch: Cmd+F over the diff opens its find panel (elsewhere it stays the thread's find).
  const find = createDiffFindState();
  const pointerInDiff = signal(false);
  registerCommand("chat.find", () => { if (!pointerInDiff() || !source()?.files?.length) return false; find.open.set(true); });
  /** The text each file's DiffView draws (nothing while folded or not loaded), in the stack's order. */
  const drawnPatchOf = (file: ChangedFile) => {
    const key = fileKeyOf(file);
    const entry = committedPatches()[key];
    if (collapsedFiles().has(key) || !entry || entry.state !== "ready" || entry.patch.trim() === "") return "";
    return fileContext.patchFor(key, entry.patch);
  };
  const matchCounts = computed(() => {
    if (!find.open()) return [] as number[];
    const params = find.params();
    const split = layout() === "split";
    return shownFiles().map((file) => countInPatch(drawnPatchOf(file), params, split));
  });
  const matchTotal = () => Math.min(100_000, matchCounts().reduce((sum, count) => sum + count, 0));
  /** The current match's file and its index there, for that file's DiffView. */
  const currentMatch = () => { const index = find.current(); return index === null ? null : locateMatch(matchCounts(), index); };
  const diffNodes = new Map<string, DiffViewRef>();
  function revealMatch(index: number) {
    const at = locateMatch(matchCounts(), index);
    const file = at ? shownFiles()[at.file] : undefined;
    if (!at || !file) return;
    revealFile(file);
    setTimeout(() => (diffNodes.get(fileKeyOf(file)) as unknown as { revealSearchMatch?: (index: number) => void } | undefined)?.revealSearchMatch?.(at.local), 300);
  }

  /** The tree's click: the list scrolls to the file's row, opened if it was folded. */
  function revealFile(file: ChangedFile) {
    selected.set(fileKeyOf(file));
    if (collapsedFiles().has(fileKeyOf(file))) setFileCollapsed(fileKeyOf(file), false);
    // The tree can point at a file well beyond the lazily-loaded window: request it directly (as a retry
    // does), rather than waiting for the scroll-driven queue to reach it.
    const cwd = props.cwd;
    if (cwd && patches()[fileKeyOf(file)] === undefined) void loadFile(generation, cwd, scope(), settingValue("diffIgnoreWhitespace") === true, file);
    const index = shownFiles().findIndex((item) => fileKeyOf(item) === fileKeyOf(file));
    if (index < 0) return;
    // The list places rows it has not drawn yet at an estimated height, so the first jump past a tall
    // file lands short. Re-issue it as the rows on the way are measured, until the target stays first.
    const list = listRef();
    if (!list) return;
    const request = ++revealRequest;
    list.scrollToIndex({ index, animated: false, viewPosition: 0 });
    let tries = 0;
    const settle = () => {
      if (request !== revealRequest || tries++ >= 8) return;
      if (firstVisibleIndex() === index) { list.scrollToIndex({ index, animated: false, viewPosition: 0 }); if (tries > 2) return; }
      else list.scrollToIndex({ index, animated: false, viewPosition: 0 });
      setTimeout(settle, 120);
    };
    setTimeout(settle, 120);
  }

  // Each row owns its own collapse (whether its DiffView renders at all, see fileRow): no native call needed.
  function setFileCollapsed(path: string, collapsed: boolean) {
    updateCollapsedFileKeys(collapseScopeKey(), (current) => { if (current.has(path) === collapsed) return current; const next = new Set(current); if (collapsed) next.add(path); else next.delete(path); return next; }, defaultCollapsedFiles());
  }

  // DiffFilePathCopyButton: the copy confirms with the anchored "Copied!" toast at the button (and its error toast).
  const copyAnchors = new Map<string, ToastAnchor>();
  function copyPath(path: string) {
    const anchor = copyAnchors.get(path);
    void Clipboard.writeText(path).then(() => {
      copied.set(path);
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => copied.set(null), 1500);
      if (anchor) void showAnchoredCopySuccessToast(anchor);
    }).catch((error: unknown) => { if (anchor) void showAnchoredCopyErrorToast(anchor, error instanceof Error ? error : new Error(String(error))); });
  }

  const ignoreWhitespace = () => settingValue("diffIgnoreWhitespace") === true;
  const layout = () => (settingValue("diffLayout") === "split" ? "split" : "stacked");
  // selectedCommitSubject / selectedGitScopeLabel / selectedScopeLabel / reviewSectionTitle (DiffPanel.tsx).
  const commitSubject = () => { const sha = commitSha(); const current = source(); return sha !== null && current?.kind === "commit" && current.headRef === sha ? current.commitSubject : null; };
  const gitScopeLabel = () => { const sha = commitSha(); return sha !== null ? (commitSubject() ?? `Commit ${sha.slice(0, 7)}`) : scope() === "working-tree" ? "Uncommitted" : "Changes"; };
  const scopeLabel = () => {
    const current = selection();
    if (current.kind === "tool-call") return "Tool call";
    if (current.kind === "turn") return selectedTurn()?.runId === latestTurn()?.runId ? "Latest turn" : `Turn ${selectedTurn()?.checkpointTurnCount ?? "?"}`;
    if (current.kind === "commit") return commitSubject() ?? "Commit";
    return gitScopeLabel();
  };
  const sectionTitle = () => {
    const current = selection();
    if (current.kind === "tool-call") return "Tool call";
    if (current.kind === "turn") return `Turn ${selectedTurn()?.checkpointTurnCount ?? "?"}`;
    return gitScopeLabel();
  };
  // review.getBranchCommits for the Commits submenu: fetched as it opens; it keeps the list it opened with.
  type BranchCommits = { commits: { sha: string; subject: string; committedAt: string }[]; truncated: boolean };
  const branchCommits = signal<BranchCommits | null>(null);
  const branchCommitsError = signal("");
  function loadBranchCommits() {
    const cwd = props.cwd;
    if (!cwd) return;
    const baseRef = selection().kind === "branch" || selection().kind === "commit" ? (selection() as { baseRef: string | null }).baseRef : null;
    void rpc("review.getBranchCommits", { cwd, ...(baseRef ? { baseRef } : {}) }).then((value) => {
      const result = value as { commits?: unknown; truncated?: unknown } | null;
      const commits = Array.isArray(result?.commits) ? result!.commits.flatMap((entry) => {
        const commit = entry as Record<string, unknown> | null;
        return commit && typeof commit.sha === "string" && typeof commit.subject === "string" ? [{ sha: commit.sha, subject: commit.subject, committedAt: typeof commit.committedAt === "string" ? commit.committedAt : "" }] : [];
      }) : [];
      branchCommitsError.set("");
      branchCommits.set({ commits, truncated: result?.truncated === true });
    }).catch((cause) => { branchCommitsError.set(cause instanceof Error ? cause.message : String(cause)); });
  }
  // The comparison target picker (Combobox in DiffPanel.tsx): vcs.listRefs local + remote, Automatic first.
  const baseRefMenuOpen = signal(false);
  useOverlayOpen(() => baseRefMenuOpen(), "diff base ref menu");
  const baseRefQuery = signal("");
  const localBaseRefs = signal<BaseVcsRef[]>([]);
  const remoteBaseRefs = signal<BaseVcsRef[]>([]);
  const selectedBaseRef = () => { const current = selection(); return current.kind === "branch" || current.kind === "commit" ? current.baseRef : null; };
  const comparisonHeadRef = () => source()?.headRef ?? "HEAD";
  const comparisonBaseRef = () => source()?.baseRef ?? selectedBaseRef() ?? "Automatic";
  const canSelectBranchBase = () => Boolean(props.cwd) && selection().kind === "branch";
  function loadBaseRefs() {
    const cwd = props.cwd;
    if (!cwd) return;
    const query = baseRefQuery().trim();
    for (const refKind of ["local", "remote"] as const) {
      void rpc("vcs.listRefs", { cwd, includeMatchingRemoteRefs: true, refKind, ...(query ? { query } : {}), limit: 100 })
        .then((value) => (refKind === "local" ? localBaseRefs : remoteBaseRefs).set(parseBaseRefs(value)))
        .catch(() => (refKind === "local" ? localBaseRefs : remoteBaseRefs).set([]));
    }
  }
  const baseRefChoices = () => buildBaseRefChoices(localBaseRefs().filter((ref) => ref.name !== comparisonHeadRef()), remoteBaseRefs());
  const pickBaseRef = (baseRef: string | null) => { baseRefMenuOpen.set(false); selectBranchBaseRef(props.threadId, baseRef); };
  const selectScope = (value: string) => {
    const key = props.threadId;
    if (value === "branch" || value === "unstaged") selectGitScope(key, value);
    else if (value.startsWith("commit:")) {
      const sha = value.slice("commit:".length);
      if (sha === commitSha()) selectGitScope(key, "branch"); else selectCommit(key, sha);
    } else if (value === "latest") { const latest = latestTurn(); if (latest) selectTurn(key, latest.runId); }
    else if (value.startsWith("turn:")) selectTurn(key, value.slice("turn:".length));
  };
  const scopeValue = () => {
    const current = selection();
    if (current.kind === "tool-call") return "";
    if (current.kind === "turn") return selectedTurn()?.runId === latestTurn()?.runId ? "latest" : `turn:${selectedTurn()?.runId ?? ""}`;
    if (current.kind === "commit") return `commit:${current.sha}`;
    return current.kind;
  };
  // The reference's order (sortedReviewFiles' filePathCollator): numeric, so file2 sorts before file10.
  // Memoized (computed, not a plain function): sorting 2,000+ files is not something every one of many
  // mounted rows should redo on every read (each row's own reactive body reads shownFiles/files through
  // commentPath); computed caches the sorted array until source() itself actually changes.
  const diffScopeKey = () => { const current = source(); return JSON.stringify([props.cwd, props.threadId, current?.kind, current?.id, current?.baseRef, current?.headRef]); };
  const stableFiles = createStableRows<ChangedFile>(fileKeyOf);
  const files = computed(() => {
    const current = source();
    return stableFiles(diffScopeKey(), withOccurrenceKeys((current?.files ?? []).slice().sort((a, b) => comparePathsNumerically(a.path, b.path))));
  });
  const defaultCollapsed = computed<ReadonlySet<string>>(() => settingValue("diffFilesCollapsed") === true ? new Set(files().map(fileKeyOf)) : new Set<string>());
  const testFileCount = () => files().filter((file) => isTestChangedFile(file.path)).length;
  // Test files drop out of the stack and the tree while hidden, except the one the reader selected.
  const shownFiles = computed(() => (hideTestFiles() ? files().filter((file) => fileKeyOf(file) === selected() || !isTestChangedFile(file.path)) : files()));
  // What the "Loading N file diffs…" footer counts from: live, so the countdown stays responsive.
  const liveNotes = () => stackedPatch(shownFiles(), patches(), { headers: true });
  // Each row's DiffView holds one file, so its annotations are that file's comments (and the draft when it is on it).
  // restoreDiffReviewCommentRange: with a thread, the comments are the composer's pending review-comment records, so they
  // come back when the diff is reopened; without one, the comments written here.
  const shownComments = (): readonly DiffComment[] => { const thread = openThread(); return thread ? restoreDiffComments(attachedExtraContexts(thread.id), (path) => `file:${path}`) : comments(); };
  const annotationsFor = (path: string) => commentAnnotations(shownComments().filter((comment) => comment.path === path), draftPath() === path && draftRange() ? { side: draftRange()!.side, start: draftRange()!.start, end: draftRange()!.end } : null);
  const clearDraft = () => { draftRange.set(null); draftPath.set(null); draftText.set(""); };
  function saveComment() {
    const path = draftPath();
    const range = draftRange();
    const text = draftText().trim();
    const thread = openThread();
    if (!path || !range || !text) return;
    const comment: DiffComment = { id: `${path}:${range.side}:${range.start}-${range.end}:${comments().length}`, path, side: range.side, start: range.start, end: range.end, text };
    const record = reviewCommentRecord(comment, patches()[path]?.patch ?? "", sectionTitle());
    comments.update((all) => [...all, comment]);
    // The composer sends the record with the next message and puts its marker in the prompt (settleSendContext).
    if (thread && record) attachExtraContext(thread.id, record as unknown as ExtraContextRecord);
    clearDraft();
  }
  const stableTreeRows = createStableRows<DiffTreeRow>((row) => row.id);
  const treeRows = computed(() => stableTreeRows(diffScopeKey(), diffTreeRows(shownFiles(), collapsedDirs())));
  const stat = () => totalStat(files());
  const loadingLabel = () => {
    const current = selection();
    if (current.kind === "tool-call") return "Loading tool call diff...";
    if (current.kind === "turn") return "Loading checkpoint diff...";
    if (current.kind === "unstaged") return "Loading uncommitted changes...";
    if (current.kind === "commit") return "Loading commit...";
    return "Loading changes...";
  };
  const omittedToolCallFiles = () => { const preview = toolCallPreview(); return preview && selection().kind === "tool-call" ? Math.max(0, preview.recordedFileCount - files().length) : 0; };
  const reload = () => { if (props.cwd || !isGitSelection()) void refresh(props.threadId, props.cwd ?? "", scope(), ignoreWhitespace()); };
  // DiffPanel.tsx:622 useLiveRefresh and useWorkspaceMutationRefresh (minimal hooks, shell-stores fix): focus / 5 min refresh,
  // and a refetch when the open thread's agent may have changed the workspace.
  useLiveRefresh(() => { if (state() !== "loading") reload(); }, { key: `diff:${props.threadId}` });
  useWorkspaceMutationRefresh({ enabled: () => openThreadForRefresh()?.id === props.threadId, mutationId: () => workspaceMutationId(), refresh: reload, resourceKey: () => `diff:${props.threadId}:${props.cwd ?? ""}` });
  // The list reporting which rows are on screen (List's onViewableItemsChange, in place of the reference's
  // per-file DiffFileLoadingBoundary intersection observers): the real visibility signal for fetching.
  const onViewableChange = (info: { viewableItems: { item: ChangedFile; index: number }[] }) => {
    if (info.viewableItems.length === 0) return;
    let lowest = info.viewableItems[0]!.index;
    let highest = lowest;
    for (const token of info.viewableItems) { if (token.index < lowest) lowest = token.index; if (token.index > highest) highest = token.index; }
    firstVisibleIndex.set(lowest);
    requestVisible(props.cwd, info.viewableItems.map((token) => token.item), highest);
  };
  const toggleDir = (id: string) => collapsedDirs.update((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const allFilesCollapsed = () => shownFiles().length > 0 && shownFiles().every((file) => collapsedFiles().has(fileKeyOf(file)));
  const toggleAllFiles = () => {
    const collapse = !allFilesCollapsed();
    for (const file of shownFiles()) setFileCollapsed(fileKeyOf(file), collapse);
  };
  const allCollapsed = () => directoryIds(files()).length > 0 && directoryIds(files()).every((id) => collapsedDirs().has(id));
  const tip = (text: string) => <Tooltip class="rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">{text}</Text></Tooltip>;
  const iconButton = (label: string, icon: string, onPress: () => void, pressed?: boolean) => (
    <View
      role="button"
      accessibilityLabel={label}
      accessibilityState={pressed === undefined ? undefined : { pressed }}
      tooltip={tip(label)}
      onPress={onPress}
      class={`size-7 items-center justify-center rounded-lg ${pressed ? "bg-accent" : "hover:bg-accent"}`}
    >
      <HIcon name={icon} size={14} />
    </View>
  );
  const menuClass = MENU_POPUP_CLASS;
  const itemClass = MENU_ITEM_ROW_CLASS;

  const patchOf = (path: string): FilePatch | undefined => patches()[path];
  // The stack's file header (DiffFileCollapseToggle, the path with its copy button, DiffFileStatus, the counts):
  // one per row now (fileRow), drawn by the panel itself rather than DiffView's renderFileHeader, since each
  // row's DiffView holds only that one file and collapsing is this component's own state, not the native one's.
  // [data-change-icon] colours: modified/renamed --diffs-modified-base (info blue; muted under blue-orange),
  // added --diffs-addition-base, deleted --diffs-deletion-base (emerald/red, or blue/orange).
  const changeIconTint = (type: HeaderChangeType): string => {
    const dark = colorScheme() === "dark";
    const blueOrange = diffColorSchemeIsBlueOrange();
    if (type === "new") return blueOrange ? (dark ? "#60a5fa" : "#2563eb") : dark ? "#34d399" : "#047857";
    if (type === "deleted") return blueOrange ? (dark ? "#fb923c" : "#ea580c") : dark ? "#f87171" : "#b91c1c";
    return blueOrange ? token("muted-foreground") : token("info");
  };
  // openDiffFilePrimaryAction: the file opens in this thread's Files tab (the right panel), when it is in the workspace.
  const openDiffFile = (filePath: string) => {
    const relative = resolveDiffPathForWorkspace({ filePath, workspaceRoot: props.cwd });
    if (relative) openFileAction(relative);
  };
  // onFileContextMenu (fileContextMenu.ts): Open, Reveal, Open with; the diff has no mention items.
  const showDiffFileMenu = (filePath: string, at: { x: number; y: number }) => {
    const cwd = props.cwd;
    const relative = resolveDiffPathForWorkspace({ filePath, workspaceRoot: cwd });
    if (!cwd || !relative) return;
    void showFileMenu({ cwd, relativePath: relative, kind: "file" }, at, () => {}, rpc, { mentions: false });
  };
  const fileHeader = (file: ChangedFile) => {
    const collapsed = () => collapsedFiles().has(fileKeyOf(file));
    const loaded = () => { const entry = committedPatches()[fileKeyOf(file)]; return entry?.state === "ready" ? entry.patch : null; };
    const type = () => headerChangeType(file, loaded());
    const previous = headerPreviousPath(file);
    return (
      // [data-diffs-header]: sticky at the top of the list while its file's lines scroll under it,
      // 32 high, padding-inline 8px 12px, the code background, no bottom border.
      <View class="h-8 flex-row items-center gap-2 bg-background pl-2 pr-3" style={{ position: "sticky", top: 0, zIndex: 4 }} accessibilityLabel={`File ${file.path}`}>
        <View
          role="button"
          accessibilityLabel={`${collapsed() ? "Expand" : "Collapse"} ${file.path}`}
          accessibilityState={{ expanded: !collapsed() }}
          tooltip={tip(collapsed() ? "Expand diff" : "Collapse diff")}
          onPress={() => setFileCollapsed(fileKeyOf(file), !collapsed())}
          class="-ml-0.5 size-5 shrink-0 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
        >
          <View class="opacity-80"><HIcon name={collapsed() ? "chevron-right" : "chevron-down"} size={16} /></View>
        </View>
        <Image src={HEADER_ICON[type()]} accessibilityLabel={`Change: ${type()}`} style={{ width: 16, height: 16, tintColor: changeIconTint(type()) }} />
        {previous !== null ? <>
          <Text class="min-w-0 shrink truncate text-xs text-foreground opacity-70" accessibilityLabel={`Renamed from ${previous}`}>{previous}</Text>
          <Image src={RENAME_ARROW} style={{ width: 16, height: 16, tintColor: token("foreground") }} />
        </> : null}
        <View
          role="link"
          accessibilityLabel={`Open ${file.path}`}
          onPress={() => openDiffFile(file.path)}
          onContextMenu={(event) => showDiffFileMenu(file.path, event.pagePosition)}
          class="min-w-0 shrink"
        >
          <Text class="truncate text-xs text-foreground">{file.path}</Text>
        </View>
        <View
          role="button"
          accessibilityLabel={`Copy ${file.path}`}
          ref={(node: ToastAnchor | null) => { if (node) copyAnchors.set(file.path, node); }}
          tooltip={tip(copied() === file.path ? "Copied" : "Copy path")}
          onPress={() => copyPath(file.path)}
          class="size-5 shrink-0 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
        >
          <HIcon name={copied() === file.path ? "check" : "copy"} size={12} />
        </View>
        <View class="flex-1" />
        {patchOf(fileKeyOf(file))?.state === "error" ? (
          <View role="button" accessibilityLabel="Retry loading diff" tooltip={tip("Retry loading diff")} onPress={() => retryFile(fileKeyOf(file))} class="size-5 shrink-0 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"><HIcon name="rotate-cw" size={12} /></View>
        ) : null}
        {patchOf(fileKeyOf(file))?.state === "ready" && patchOf(fileKeyOf(file))?.truncated ? (
          <View accessibilityLabel="Partial diff preview" tooltip={tip("This file is too large to show in full. Counts include all changes.")} class="size-5 shrink-0 items-center justify-center rounded-md"><HIcon name="info" size={12} /></View>
        ) : null}
        {/* [data-metadata] (DiffStatLabel): the counts in the mono face at 11px, 1ch apart. */}
        <View class="shrink-0 flex-row items-center gap-[7px]">
          <Text class={`font-mono ${diffAdditionClass("text-emerald-700 dark:text-emerald-400")}`} style={{ fontSize: 11 }}>{`+${compactCount(file.additions)}`}</Text>
          <Text class={`font-mono ${diffDeletionClass("text-red-700 dark:text-red-400")}`} style={{ fontSize: 11 }}>{`-${compactCount(file.deletions)}`}</Text>
        </View>
      </View>
    );
  };
  // One row of the files List: the header above, then that file's own DiffView (nothing while collapsed,
  // pending, empty or failed). Keyed by path (see the List below), so a file whose patch has not changed
  // keeps the exact same props across a commit and is never re-parsed or re-highlighted; a file that has
  // not been requested at all yet (still outside the loaded window) draws its header only, same as reference.
  // R3: the line height follows the diff surface zoom (shell/surfaceZoom.ts).
  const diffLineHeight = () => scaledFor("diff", 20);
  const HEADER_HEIGHT = 32;
  /** StyledDiffCodeView's hunk separator height (24px, exact). */
  const SEPARATOR_HEIGHT = 24;
  // DiffView's own measured content height, by path, once it has reported one (its onScroll's
  // contentSize): the real row height. Until then, rowEstimate below is only a placeholder so DiffView
  // (which virtualises internally and needs a bounded height to know what is "in view") has somewhere
  // concrete to lay out into — never the final answer, which is why the placeholder's exactness does not
  // matter: a wrong placeholder self-corrects the moment this file's own DiffView lays out.
  const measuredHeights = signal<Record<string, number>>({});
  // A placeholder good enough to keep the initial jump small: every real diff line (added, removed,
  // context) plus one row per hunk separator, excluding the patch-format lines ("diff --git", "index",
  // "---", "+++") that are never drawn as rows at all (DiffView reads them as the file's identity, not
  // its content). Not wrap-aware; the measured height corrects that once it lands.
  function estimateBodyLines(patch: string): number {
    let rows = 0;
    for (const line of patch.split("\n")) {
      if (line === "" || line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) continue;
      rows++; // a "@@ ... @@" hunk header counts as its own separator row, same as every content line
    }
    return rows;
  }
  // Lines are built lazily, as the reference's CodeView virtualiser does (StyledDiffCodeView itemMetrics):
  // a row keeps its full height in the outer List (so the list's own scroll covers the whole stack), but its
  // DiffView is only a viewport tall, held under the sticky header (position: sticky, top 32) for as long as
  // its file is on screen, and scrolled internally to the part of the file that window covers. DiffView
  // makes only the rows in its own view, so a 30,000-line file builds about a screenful, not every line.
  // A wheel over the DiffView scrolls it first; that movement is handed to the outer list (scrollBy).
  const listScrollY = signal(0);
  const listViewportHeight = signal(0);
  const fileRow = (file: () => ChangedFile, _index: () => number) => {
    const path = () => file().path;
    const key = () => fileKeyOf(file());
    const body = () => {
      if (collapsedFiles().has(key())) return "";
      const entry = committedPatches()[key()];
      if (!entry || entry.state !== "ready") return "";
      return entry.patch.trim() === "" ? "" : fileContext.patchFor(key(), entry.patch);
    };
    // The file's own patch as the server sent it: what the hunk separators' gaps count from.
    const rawPatch = () => committedPatches()[key()]?.patch ?? "";
    // Pierre's isExpandableDiff: a git selection the host's files can be read for, on a file whose context hydrates.
    const expandable = () => isGitSelection() && canReadFiles() && canHydrateContext(diffChangeType(file(), rawPatch()), rawPatch());
    const gaps = () => fileContext.gapsFor(key(), rawPatch());
    // The separator below the last hunk (the DiffView draws one above each hunk only).
    const trailing = () => { if (!body() || !expandable()) return null; const all = gaps(); const last = all[all.length - 1]; return last && last.lines !== 0 ? last : null; };
    const separator = (gap: number) => {
      const entry = gaps()[gap];
      if (!entry || entry.lines === 0) return <View class="h-0" />;
      return <DiffContextSeparator lines={entry.lines} first={entry.first} last={false} expandable={expandable()} onExpand={(action) => fileContext.expand(key(), rawPatch(), entry.gap, action)} />;
    };
    const bodyHeight = () => {
      const text = body();
      if (!text) return 0;
      const measured = measuredHeights()[key()];
      return measured ?? Math.max(1, estimateBodyLines(text)) * diffLineHeight();
    };
    const windowHeight = () => Math.min(bodyHeight(), Math.max(diffLineHeight() * 6, listViewportHeight() - HEADER_HEIGHT));
    const windowed = () => bodyHeight() > windowHeight();
    let rowNode: ViewRef | null = null;
    let diffNode: DiffViewRef | null = null;
    let innerOffset = 0;
    // Until then, the DiffView reporting an offset is the echo of our own setScrollOffset, not the reader.
    let echoUntil = 0;
    let syncToken = 0;
    // Outer scroll -> inner offset: how far the row's top has gone above the list's top, clamped to the file.
    effect(() => {
      void listScrollY();
      const isWindowed = windowed();
      const max = bodyHeight() - windowHeight();
      if (!isWindowed) { innerOffset = 0; return; }
      const token = ++syncToken;
      const row = rowNode;
      const list = listRef();
      if (!row || !list) return;
      void Promise.all([row.measure(), list.measure()]).then(([rowAt, listAt]) => {
        if (token !== syncToken || !rowAt || !listAt) return;
        // Only a row that actually overlaps the list's viewport is synced (a recycled or off-screen cell
        // can measure anywhere).
        const rel = rowAt.pagePosition.y - listAt.pagePosition.y;
        if (rel > listViewportHeight() || rel + HEADER_HEIGHT + bodyHeight() < 0) return;
        const target = Math.max(0, Math.min(max, -rel));
        if (Math.abs(target - innerOffset) < 0.5) return;
        innerOffset = target;
        echoUntil = Date.now() + 250;
        diffNode?.setScrollOffset({ x: 0, y: target });
      }).catch(() => {});
    });
    return (
      <View ref={(node: ViewRef) => { rowNode = node; }} accessibilityLabel={`File ${path()}`} style={{ height: HEADER_HEIGHT + bodyHeight() + (trailing() ? SEPARATOR_HEIGHT : 0) }}>
        {fileHeader(file())}
        {body() ? (
          <DiffView
            ref={(node: DiffViewRef) => { diffNode = node; diffNodes.set(key(), node); }}
            patch={body()}
            {...({
              search: find.open() && find.params().text !== "" ? find.params().text : null,
              searchCaseSensitive: find.params().caseSensitive,
              searchWholeWord: find.params().wholeWord,
              searchRegex: find.params().regex,
              searchCurrent: (() => { const at = currentMatch(); return at && shownFiles()[at.file] && fileKeyOf(shownFiles()[at.file]!) === key() ? at.local : null; })(),
            } as object)}
            layout={layout() === "split" ? "split" : "unified"}
            softWrap={wordWrap()}
            annotations={annotationsFor(path())}
            renderAnnotation={(annotation) => (annotation.id === "draft" ? commentEditor() : savedComment(annotation.id))}
            renderAddAnnotation={(range) => (
              <View role="button" accessibilityLabel="Add a comment" onPress={() => { draftPath.set(path()); draftRange.set(range); draftText.set(""); }} class="size-4 items-center justify-center rounded bg-primary"><HIcon name="plus" size={12} /></View>
            )}
            classes={diffViewColorClasses()}
            lineHeight={diffLineHeight()}
            fontSize={scaledFor("diff", 13)}
            renderSeparator={(value) => separator(value.gap)}
            onScroll={(event) => {
              const height = Math.ceil(event.contentSize.height);
              measuredHeights.update((all) => (all[key()] === height ? all : { ...all, [key()]: height }));
              // Inner scroll the app did not ask for (a wheel over the lines): move the whole list instead.
              const delta = event.offset.y - innerOffset;
              if (Date.now() < echoUntil) { innerOffset = event.offset.y; return; }
              if (windowed() && Math.abs(delta) >= 1) {
                innerOffset = event.offset.y;
                listRef()?.scrollToOffset({ offset: Math.max(0, listScrollY() + delta), animated: false });
              }
            }}
            style={{ position: "sticky", top: HEADER_HEIGHT, height: windowHeight() }}
            class="min-h-0"
          />
        ) : null}
        {trailing() ? (
          <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: SEPARATOR_HEIGHT }}>
            <DiffContextSeparator lines={trailing()!.lines} first={false} last expandable onExpand={(action) => fileContext.expand(key(), rawPatch(), trailing()!.gap, action)} />
          </View>
        ) : null}
      </View>
    );
  };
  // Files with no diff under their header: in flight, failed, empty or cut short. Not-yet-requested files
  // (the vast majority in a large diff, reference parity: no text at all, just the row's own header
  // skeleton) are deliberately left out here — that was the old "Loading 1,739 file diffs..." line, which
  // actually meant "not yet requested" and kept reading the same stale backlog size long after every real
  // request had settled, looking exactly like the flood it was reporting on. This counts only genuine
  // network activity (`inFlight`, bounded by PATCH_CONCURRENCY), so it disappears the moment nothing is.
  const stackNotes = () => {
    const notes = liveNotes();
    const loading = inFlight();
    if (loading === 0 && notes.failed.length === 0 && notes.empty.length === 0 && notes.truncated.length === 0) return null;
    return (
      <Scroll class="max-h-28 shrink-0 border-t border-border-60" accessibilityLabel="Files without a diff">
        {loading > 0 ? <Text class="px-3 py-1.5 text-xs text-muted-foreground">{loading === 1 ? "Loading file diff..." : `Loading ${loading} file diffs...`}</Text> : null}
        <Each of={notes.failed} key={(item) => item.key}>
          {(item) => (
            <View class="flex-row items-center gap-2 px-3 py-1.5">
              <Text class="min-w-0 flex-1 truncate text-xs text-destructive">{`${item().path}: ${item().error}`}</Text>
              <View role="button" accessibilityLabel={`Retry loading diff for ${item().path}`} onPress={() => retryFile(item().key)} class="rounded-md border border-border px-2 py-0.5"><Text class="text-xs text-foreground">Retry</Text></View>
            </View>
          )}
        </Each>
        <Each of={notes.empty} key={(path) => path}>{(path) => <Text class="px-3 py-1.5 text-xs text-muted-foreground">{`${path()}: No textual diff is available for this file.`}</Text>}</Each>
        {notes.truncated.length > 0 ? <Text class="px-3 py-1.5 text-xs text-muted-foreground">This diff is incomplete or truncated.</Text> : null}
      </Scroll>
    );
  };

  // isCommentSubmitShortcut: Mod+Enter submits a non-empty comment while its field has the keyboard.
  const commentFocused = signal(false);
  effect(() => {
    if (!commentFocused() || !draftRange()) return;
    return keymap.bind("mod+enter", () => { if (draftText().trim().length > 0) saveComment(); }, { when: "always" });
  });
  const commentEditor = () => (
    <View class="gap-2 border-y border-border bg-card p-2" accessibilityLabel="New comment">
      <Input
        multiline
        accessibilityLabel={`Comment on lines ${draftRange() ? `${draftRange()!.start + 1}${draftRange()!.end > draftRange()!.start ? ` to ${draftRange()!.end + 1}` : ""}` : ""}`}
        placeholder="Add a comment…"
        value={draftText()}
        onChange={(event) => draftText.set(event.value)}
        onKeyPress={(event) => { if (event.key === "Escape") clearDraft(); }}
        onFocus={() => commentFocused.set(true)}
        onBlur={() => commentFocused.set(false)}
        class="min-h-16 w-full rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
      />
      <View class="flex-row items-center justify-end gap-2">
        <View role="button" accessibilityLabel="Cancel comment" onPress={clearDraft} class="h-6 items-center justify-center rounded-md px-2 hover:bg-accent"><Text class="text-xs text-foreground">Cancel</Text></View>
        <View role="button" accessibilityLabel="Comment" disabled={draftText().trim() === ""} onPress={saveComment} class={`h-6 items-center justify-center rounded-md bg-primary px-2 ${draftText().trim() === "" ? "opacity-64" : ""}`}><Text class="text-xs text-primary-foreground">Comment</Text></View>
      </View>
    </View>
  );
  const savedComment = (id: string) => {
    const comment = shownComments().find((item) => item.id === id);
    return (
      <View class="gap-1 border-y border-border bg-card px-3 py-2" accessibilityLabel="Review comment">
        <Text class="text-xs text-foreground">{comment?.text ?? ""}</Text>
        <View class="flex-row items-center justify-end">
          <View role="button" accessibilityLabel="Delete comment" onPress={() => { comments.update((all) => all.filter((item) => item.id !== id)); const thread = openThread(); if (thread) detachExtraContext(thread.id, id); }} class="size-5 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"><HIcon name="trash-2" size={12} /></View>
        </View>
      </View>
    );
  };

  // Re-anchoring: a file loading (or its measured height replacing the estimate) ABOVE the viewport would
  // push what the reader is looking at down or up. Compensates by exactly the height change of the rows above the first visible one, so the reader's
  // place inside a tall file (a 30,000-line one) is kept, rather than snapping back to that file's top.
  let previousRowHeights = new Map<string, number>();
  effect(() => {
    const committed = committedPatches();
    const measured = measuredHeights();
    const collapsed = collapsedFiles();
    const next = new Map<string, number>();
    let shift = 0;
    untracked(() => {
      const ordered = shownFiles();
      const first = firstVisibleIndex();
      ordered.forEach((file, index) => {
        const id = fileKeyOf(file);
        const entry = committed[id];
        const text = collapsed.has(id) || !entry || entry.state !== "ready" || entry.patch.trim() === "" ? "" : entry.patch;
        const height = HEADER_HEIGHT + (text ? (measured[id] ?? Math.max(1, estimateBodyLines(text)) * diffLineHeight()) : 0);
        next.set(id, height);
        const before = previousRowHeights.get(id);
        if (index < first && before !== undefined) shift += height - before;
      });
    });
    previousRowHeights = next;
    const list = listRef();
    if (!list || shift === 0) return;
    const target = Math.max(0, untracked(() => listScrollY()) + shift);
    queueMicrotask(() => list.scrollToOffset({ offset: target, animated: false }));
  });
  return <View class="h-full min-w-0 flex-1 flex-col bg-background" {...surfaceZoomTarget("diff")}>
    <View class="min-h-10 shrink-0 flex-row flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5" role="toolbar" accessibilityLabel="Diff controls">
      <View class="min-w-40 max-w-full flex-1 flex-row items-center gap-3 overflow-hidden">
        <Menu
          open={scopeMenuOpen()}
          onOpenChange={(event) => { scopeMenuOpen.set(event.open); if (event.open) { branchCommits.set(null); loadBranchCommits(); } }}
          popupClass={menuClass}
          trigger={
            <View role="button" accessibilityLabel={`Diff scope: ${scopeLabel()}`} class="h-7 max-w-full flex-row items-center gap-1 rounded-lg bg-secondary px-2.5">
              <Text class="truncate text-xs text-secondary-foreground">{scopeLabel()}</Text>
              <HIcon name="chevron-down" size={14} />
            </View>
          }
        >
          <MenuItem role="menuitemradio" checked={scopeValue() === "branch"} accessibilityLabel="Changes" class={itemClass} onSelect={() => selectScope("branch")}><Text class="text-sm text-popover-foreground">Changes</Text></MenuItem>
          <MenuItem role="menuitemradio" checked={scopeValue() === "unstaged"} accessibilityLabel="Uncommitted" class={itemClass} onSelect={() => selectScope("unstaged")}><Text class="text-sm text-popover-foreground">Uncommitted</Text></MenuItem>
          <MenuItem role="menuitemradio" checked={scopeValue() === "latest"} accessibilityLabel="Latest turn" class={itemClass} onSelect={() => selectScope("latest")}><Text class="text-sm text-popover-foreground">Latest turn</Text></MenuItem>
          <Submenu trigger={<MenuItem accessibilityLabel="Turn" closeOnSelect={false} class={itemClass}><Text class="flex-1 text-sm text-popover-foreground">Turn</Text><HIcon name="chevron-right" size={14} /></MenuItem>}>
            <View class={MENU_SUBPOPUP_CLASS}>
              {turns().map((summary) => (
                <MenuItem role="menuitemradio" checked={selection().kind === "turn" && selectedTurn()?.runId === summary.runId} accessibilityLabel={`Turn ${summary.checkpointTurnCount}`} class={itemClass} onSelect={() => selectScope(`turn:${summary.runId}`)}>
                  <Text class="text-sm text-popover-foreground">{`Turn ${summary.checkpointTurnCount}`}</Text>
                  <Text class="ml-auto text-xs tabular-nums text-muted-foreground">{formatShortTimestamp(Date.parse(summary.completedAt), asTimestampFormat(settingValue("timestampFormat")))}</Text>
                </MenuItem>
              ))}
            </View>
          </Submenu>
          <Submenu trigger={<MenuItem accessibilityLabel="Commits" closeOnSelect={false} class={itemClass}><Text class="flex-1 text-sm text-popover-foreground">Commits</Text><HIcon name="chevron-right" size={14} /></MenuItem>}>
            <Scroll class={`max-h-80 max-w-96 ${MENU_SUBPOPUP_CLASS.replace("max-w-56 ", "")}`}>
              {(branchCommits()?.commits ?? []).map((commit) => (
                <MenuItem role="menuitemradio" checked={commitSha() === commit.sha} accessibilityLabel={commit.subject} tooltip={tip(commit.subject)} class={itemClass} onSelect={() => selectScope(`commit:${commit.sha}`)}>
                  <Text class="min-w-0 flex-1 truncate text-sm text-popover-foreground">{commit.subject}</Text>
                  <Text class="shrink-0 text-xs tabular-nums text-muted-foreground">{formatRelativeTimeLabel(Date.parse(commit.committedAt), Date.now())}</Text>
                  <Text class="shrink-0 px-2 font-mono text-xs text-muted-foreground">{commit.sha.slice(0, 7)}</Text>
                </MenuItem>
              ))}
              {branchCommitsError() ? <MenuItem disabled class={itemClass}><Text class="text-sm text-muted-foreground">{branchCommitsError()}</Text></MenuItem>
                : branchCommits() === null ? <MenuItem disabled class={itemClass}><Text class="text-sm text-muted-foreground">Loading commits...</Text></MenuItem>
                : branchCommits()!.commits.length === 0 ? <MenuItem disabled class={itemClass}><Text class="text-sm text-muted-foreground">No commits on this branch.</Text></MenuItem>
                : branchCommits()!.truncated ? <MenuItem disabled class={itemClass}><Text class="text-sm text-muted-foreground">{`Showing latest ${branchCommits()!.commits.length} commits`}</Text></MenuItem>
                : null}
            </Scroll>
          </Submenu>
        </Menu>
        {selection().kind === "commit" ? <Text class="shrink-0 font-mono text-xs text-muted-foreground">{commitSha()!.slice(0, 7)}</Text> : null}
        {canSelectBranchBase() ? (
          <View class="min-w-0 max-w-full flex-row items-center gap-2" accessibilityLabel={`Comparing ${comparisonHeadRef()} against ${comparisonBaseRef()}`}>
            <View class="min-w-0 flex-row items-center gap-2" tooltip={tip(`${comparisonHeadRef()} \u2192 ${comparisonBaseRef()}`)}>
              <Text class="min-w-0 max-w-48 truncate text-xs text-muted-foreground">{comparisonHeadRef()}</Text>
              <View class="opacity-70"><HIcon name="arrow-right" size={14} /></View>
            </View>
            <Menu
              open={baseRefMenuOpen()}
              onOpenChange={(event) => { baseRefMenuOpen.set(event.open); if (event.open) loadBaseRefs(); else baseRefQuery.set(""); }}
              popupClass={`w-72 ${menuClass}`}
              trigger={
                <View role="button" accessibilityLabel={`Change comparison target. Currently ${comparisonBaseRef()}`} class="h-7 min-w-9 max-w-48 shrink-0 flex-row items-center gap-1 rounded-lg px-2 hover:bg-accent">
                  <Text class="min-w-0 truncate text-xs text-muted-foreground">{comparisonBaseRef()}</Text>
                  <HIcon name="chevron-down" size={14} />
                </View>
              }
            >
              <View class="h-8 flex-row items-center border-b border-border px-2">
                <Input value={baseRefQuery()} onChange={(event) => { baseRefQuery.set(event.value); loadBaseRefs(); }} placeholder="Search refs..." accessibilityLabel="Search refs" class="h-8 min-w-0 flex-1 bg-transparent text-sm text-foreground" />
              </View>
              <View class="flex-row items-center border-b border-border-70 px-3 pt-2 pb-1.5">
                <Text class="flex-1 text-3xs font-medium uppercase text-muted-foreground">Branch</Text>
                <Text class="w-8 text-right text-3xs font-medium uppercase text-muted-foreground">Remote</Text>
              </View>
              <Scroll class="max-h-64">
                {baseRefQuery().trim().length === 0 ? <MenuItem role="menuitemradio" checked={selectedBaseRef() === null} accessibilityLabel="Automatic" class={itemClass} onSelect={() => pickBaseRef(null)}><Text class="text-sm text-popover-foreground">Automatic</Text></MenuItem> : null}
                {filterBaseRefChoices(baseRefChoices(), baseRefQuery()).map((choice) => {
                  const value = valueForBaseRefChoice(choice, selectedBaseRef());
                  const useRemote = choice.remote?.name === value;
                  return (
                    <MenuItem role="menuitemradio" checked={selectedBaseRef() === value} accessibilityLabel={choice.label} class={itemClass} onSelect={() => pickBaseRef(value)}>
                      <Text class="min-w-0 flex-1 truncate text-sm text-popover-foreground">{choice.label}</Text>
                      {choice.local && choice.remote ? (
                        <View role="switch" accessibilityLabel={`Use remote version of ${choice.label}`} accessibilityState={{ checked: useRemote }} onPress={() => pickBaseRef(useRemote ? choice.local!.name : choice.remote!.name)} class={`h-3 w-6 rounded-full ${useRemote ? "bg-primary" : "bg-input"}`} />
                      ) : choice.remote ? (
                        <View accessibilityLabel="Remote only" tooltip={tip("Remote only")} class="w-8 items-end"><HIcon name="check" size={12} /></View>
                      ) : null}
                    </MenuItem>
                  );
                })}
                {filterBaseRefChoices(baseRefChoices(), baseRefQuery()).length === 0 && baseRefQuery().trim().length > 0 ? <MenuItem disabled class={itemClass}><Text class="text-sm text-muted-foreground">No matching refs.</Text></MenuItem> : null}
              </Scroll>
            </Menu>
          </View>
        ) : null}
      </View>
      <View class="ml-auto max-w-full shrink-0 flex-row flex-wrap items-center justify-end gap-1">
        {files().length > 0 ? (
          <View role="group" accessibilityLabel={`${stat().additions} additions, ${stat().deletions} deletions`} class="mr-1 flex-row items-center gap-1">
            <Text class={`font-mono text-2xs ${diffAdditionClass("text-emerald-700 dark:text-emerald-400")}`}>{`+${compactCount(stat().additions)}`}</Text>
            <Text class={`font-mono text-2xs ${diffDeletionClass("text-red-700 dark:text-red-400")}`}>{`-${compactCount(stat().deletions)}`}</Text>
          </View>
        ) : null}
        {files().length > 0 ? iconButton(allFilesCollapsed() ? "Expand all files" : "Collapse all files", allFilesCollapsed() ? "chevrons-up-down" : "chevrons-down-up", toggleAllFiles) : null}
        {props.cwd ? iconButton(refreshing() ? "Refreshing diff" : "Refresh diff", "rotate-cw", reload) : null}
        <View role="group" accessibilityLabel="Diff layout" class="h-6 flex-row items-center rounded-md bg-segmented-track p-0.5">
          <View role="button" accessibilityLabel="Stacked diff view" accessibilityState={{ pressed: layout() === "stacked" }} onPress={() => updateSetting("diffLayout", "stacked")} class={`h-5 w-7 items-center justify-center rounded transition-colors duration-150 ease-in-out ${layout() === "stacked" ? "bg-segmented-active" : ""}`}><HIcon name="rows-3" size={14} /></View>
          <View role="button" accessibilityLabel="Split diff view" accessibilityState={{ pressed: layout() === "split" }} onPress={() => updateSetting("diffLayout", "split")} class={`h-5 w-7 items-center justify-center rounded transition-colors duration-150 ease-in-out ${layout() === "split" ? "bg-segmented-active" : ""}`}><HIcon name="columns-2" size={14} /></View>
        </View>
        {iconButton(wordWrap() ? "Disable diff line wrapping" : "Enable diff line wrapping", "text-wrap", () => wordWrap.update((value) => !value), wordWrap())}
        {iconButton(ignoreWhitespace() ? "Show whitespace changes" : "Hide whitespace changes", "pilcrow", () => updateSetting("diffIgnoreWhitespace", !ignoreWhitespace()), ignoreWhitespace())}
        {testFileCount() > 0 ? iconButton(hideTestFiles() ? `Show ${testFileCount()} hidden test ${testFileCount() === 1 ? "file" : "files"}` : "Hide test files", "flask-conical-off", () => setHideTestFiles(!hideTestFiles()), hideTestFiles()) : null}
        {files().length > 0 ? iconButton(fileTreeOpen() ? "Hide file tree" : "Show file tree", "folder-tree", () => setFileTreeOpen(!fileTreeOpen()), fileTreeOpen()) : null}
      </View>
    </View>
    {!props.cwd && isGitSelection() ? <View class="px-4 py-6"><Text class="text-sm text-muted-foreground">This thread does not have a project folder.</Text></View> : null}
    {selection().kind === "turn" && turns().length === 0 ? <View class="flex-1 items-center justify-center px-5"><Text class="text-center text-xs text-muted-foreground-70">No completed turns yet.</Text></View> : null}
    {state() === "loading" && !(selection().kind === "turn" && turns().length === 0) ? <View class="px-4 py-6" accessibilityLabel="Loading changes"><Text class="text-sm text-muted-foreground">{loadingLabel()}</Text></View> : null}
    {state() === "error" ? <View class="gap-3 px-4 py-6"><Text class="text-sm text-destructive">{error()}</Text><View accessibilityLabel="Retry changes" role="button" onPress={reload} class="self-start rounded-md border border-border px-3 py-1.5"><Text class="text-xs text-foreground">Retry</Text></View></View> : null}
    {state() === "ready" && error() ? <Text role="alert" class="px-4 py-2 text-xs text-destructive">{`Could not refresh changes: ${error()}`}</Text> : null}
    {state() === "ready" && !source() && isGitSelection() ? <View class="flex-1 items-center justify-center px-5"><Text class="text-center text-xs text-muted-foreground-70">Turn diffs are unavailable because this project is not a git repository.</Text></View> : null}
    {hasReadySource() ? <>
      {incomplete() ? <Text class="border-b border-border-70 bg-muted-40 px-3 py-1.5 text-2xs text-muted-foreground">Showing tracked changes. Untracked changes could not be loaded. Refresh to retry.</Text> : null}
      {source()?.truncated ? <Text class="border-b border-border-70 bg-muted-40 px-3 py-1.5 text-2xs text-muted-foreground">{`This preview exceeds the size limit. Changes shown are incomplete.${isGitSelection() && source()?.files && !incomplete() ? " Totals include all changes." : ""}`}</Text> : null}
      {omittedToolCallFiles() > 0 ? <Text class="border-b border-border-70 bg-muted-40 px-3 py-1.5 text-2xs text-muted-foreground">{`This tool call changed ${toolCallPreview()!.recordedFileCount} files. The recorded patch omits ${omittedToolCallFiles()} of them.`}</Text> : null}
      {source()?.files?.length === 0 && (toolCallPreview()?.content.length ?? 0) > 0 ? (
        <Scroll class="min-h-0 flex-1 p-3" accessibilityLabel="Recorded content">
          <View class="gap-3">
            <Text class="text-xs text-muted-foreground">The provider recorded file content without a diff.</Text>
            {toolCallPreview()!.content.map((entry) => (
              <View class="gap-1">
                <Text class="text-xs text-muted-foreground">{entry.label}</Text>
                <Text class={`font-mono text-2xs text-foreground ${wordWrap() ? "" : "whitespace-nowrap"}`}>{entry.text === "" ? "Empty content." : entry.text}</Text>
              </View>
            ))}
          </View>
        </Scroll>
      ) : source()?.files?.length === 0 ? <View class="flex-1 items-center justify-center px-3 py-2"><Text class="text-xs text-muted-foreground-70">{source()!.diff.trim() === "" && !incomplete() ? "No net changes in this selection." : "No patch available for this selection."}</Text></View> : null}
      {hasSourceFiles() ? <View class="relative min-h-0 flex-1 flex-row" onLayout={(event) => rowWidth.set(event.bounds.size.width)} onMouseEnter={() => pointerInDiff.set(true)} onMouseLeave={() => pointerInDiff.set(false)}>
        <DiffFindBar state={find} count={matchTotal} onReveal={revealMatch} />
        <View class="min-h-0 min-w-0 flex-1" accessibilityLabel="Changed files diff">
          {/* One DiffView per file (fileRow), virtualised: only rows near the viewport exist, each keyed by
              its path so scrolling recycles cells without disturbing a file's own loaded state, and an
              arriving file's props change on its own row alone, never the others (see fileRow, body()). */}
          <List
            ref={(node) => listRef.set(node)}
            each={shownFiles()}
            keyExtractor={fileKeyOf}
            onViewableItemsChange={onViewableChange}
            onScroll={(event) => listScrollY.set(event.offset.y)}
            onLayout={(event) => listViewportHeight.set(event.bounds.size.height)}
            estimatedItemSize={120}
            class="min-h-0 flex-1"
            testID="Changed files diff rows"
          >
            {fileRow}
          </List>
          {stackNotes()}
        </View>
        {fileTreeOpen() ? (
          <View style={{ width: treeResize.live() ?? treeWidth() }} class="relative shrink-0 border-l border-border" accessibilityLabel="Changed files">
            <View
              accessibilityLabel="Resize Changes files"
              role="button"
              focusable={false}
              class="absolute inset-y-0 left-0 z-10 w-[8px]"
              style={{ cursor: "col-resize" }}
              onMouseMove={treeResize.follow}
              onPress={() => {}}
              onPanStart={treeResize.handle.onPanStart}
              onPanEnd={treeResize.handle.onPanEnd}
            >
              <View class={`absolute inset-y-0 left-0 w-px ${treeResize.live() !== null ? "bg-primary" : "bg-transparent hover:bg-border"}`} />
              {treeResize.live() !== null ? <Overlay class="inset-0 z-50" accessibilityLabel="Resizing changed files" style={{ cursor: "col-resize" }} onMouseMove={treeResize.follow} /> : null}
            </View>
            {/* DiffFileTree.tsx's own header: h-10/min-h-10 in its (non-inline) panel mode, which this
                standalone Changes surface is -- the h-7 the reference shows is its inline file-preview mode. */}
            <View class="h-10 min-h-10 shrink-0 flex-row items-center gap-1 px-2">
              <Text class="px-1 text-xs font-medium text-foreground">Files</Text>
              <View class="flex-1" />
              <Text class="text-xs text-muted-foreground">{String(shownFiles().length)}</Text>
              {directoryIds(shownFiles()).length > 0 ? (
                <View role="button" accessibilityLabel={allCollapsed() ? "Expand all folders" : "Collapse all folders"} onPress={() => collapsedDirs.set(allCollapsed() ? new Set() : new Set(directoryIds(shownFiles())))} class="size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out">
                  <HIcon name={allCollapsed() ? "chevron-down" : "chevron-up"} size={14} />
                </View>
              ) : null}
            </View>
            <Scroll class="min-h-0 flex-1" testID="Changed files tree"><Each of={treeRows()} key={(row) => row.id}>
              {(row) => row().kind === "directory" ? (
                <View role="treeitem" accessibilityLabel={`Folder ${row().label}`} accessibilityState={{ expanded: row().expanded }} onPress={() => toggleDir(row().id)} style={{ paddingLeft: 8 + row().depth * 12 }} class="h-6 flex-row items-center gap-1 pr-2 transition-colors duration-150 ease-in-out hover:bg-accent-50">
                  <ChevronTurn open={() => row().expanded}><HIcon name="chevron-right" size={12} /></ChevronTurn>
                  <Text class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{row().label}</Text>
                </View>
              ) : (
                <View role="treeitem" accessibilityLabel={`Show changes in ${row().file?.path ?? row().id}`} accessibilityState={{ selected: selected() === row().id }} onPress={() => { const target = row().file; if (target) revealFile(target); }} style={{ paddingLeft: 8 + row().depth * 12 + 16 }} class={`h-6 flex-row items-center gap-1 pr-2 transition-colors duration-150 ease-in-out ${selected() === row().id ? "bg-accent" : "hover:bg-accent-50"}`}>
                  <Text class="min-w-0 flex-1 truncate text-xs text-foreground">{row().label}</Text>
                  <Text class={`text-2xs ${row().status === "renamed" ? "text-info-foreground" : "text-warning-foreground"}`}>{statusMark(row().status ?? "modified")}</Text>
                </View>
              )}
            </Each></Scroll>
          </View>
        ) : null}
      </View> : null}
      {/* The server could not list files individually here, so there is no ChangedFile metadata to drive
          fileHeader or the lazy loader; DiffView parses and headers this single whole patch itself. */}
      {source()?.files === null && wholePatch() ? <DiffView patch={wholePatch()} layout={layout() === "split" ? "split" : "unified"} softWrap={wordWrap()} classes={diffViewColorClasses()} class="min-h-0 flex-1" /> : null}
    </> : null}
  </View>;
}
