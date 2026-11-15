// The Code tab, ported from PullRequestCodeTab.tsx: the toolbar (diff scope, file count and viewed-tick notices,
// diff options, fold all, hide test files, file tree), the pull request's diff rendered inline with a header per
// file (fold, counts, viewed tick), the file tree, the conversations the diff does not show, and paging.
import { computed, effect, Scroll, signal, Text, untracked, View } from "nsh";
import { DiffView } from "nsh/base";
import type { DiffFile, DiffViewRef } from "nsh/base";
import { PRIcon } from "./PRIcon";
import type { PullRequestFinding } from "./pullRequestHandoff.logic";
import { DiffCommentForm, draftRangeLabel, PendingReviewCommentCard, ReviewThreadCard } from "./PullRequestReviewAnnotation";
import type { PullRequestActionsModel } from "./pullRequestActionsModel";
import type { PullRequestReviewModel } from "./pullRequestReviewModel";
import type { PendingReviewComment, ReviewThread } from "./pullRequestReview.logic";
import { PullRequestDiffUnavailableState } from "./PullRequestDiffUnavailableState";
import type { PullRequestCodeModel } from "./pullRequestCodeModel";
import { formatCount } from "./pullRequestPresentation";
import { changeRequestTerm } from "./pullRequestCheckout.logic";
import { isFileDiffCollapsed, toggleFileDiffFoldForViewed, type DiffFoldOverride } from "./pullRequestDiff.logic";
import { fileTreeOpen, setFileTreeOpen, setHideTestFiles } from "./pullRequestCodePrefs";
import { APP_BASE_NAME, DiffOptionsMenu, DiffScopeMenu, IconToggle, MetaDot, NoteIcon, TOOLBAR_WIDE_PX, tip } from "./PullRequestCodeToolbar";
import { PullRequestFileTree } from "./PullRequestCodeFileTree";
import { diffAdditionClass, diffDeletionClass, diffViewColorClasses } from "../diff/diffColorScheme";
import { settingValue, updateSetting } from "../../store";
import { ChevronTurn, toggleWithLayout } from "../motion/Motion";
import { COLLAPSE_MS } from "../motion/motionTokens";
import { HIcon } from "../header/HeaderIcons";
import { canHydrateContext, diffChangeType, hunkIndex, readDiffFileContents, splitPatchFiles } from "../diff/diffContext";
import { createDiffContextState } from "../diff/diffContextState";
import { DiffContextSeparator } from "../diff/DiffContextSeparator";
import { patchFiles } from "./pullRequestDiff.logic";
import { DiffFindBar, createDiffFindState } from "../diff/DiffFindBar";
import { countInPatch } from "../diff/diffSearch";
import { registerCommand } from "../../commands/registry";

/** Conversations the current diff does not show (outdated, or on a file not loaded yet), as the web lists them above the diff. */
function OrphanThreads(props: { review: PullRequestReviewModel; actions: PullRequestActionsModel; now: () => number; more: () => boolean; onFixFinding?: (finding: PullRequestFinding) => void; fixLabel?: () => string; onAddToChat?: (thread: ReviewThread) => void }) {
  const open = signal(false);
  const byPath = () => {
    const files = new Map<string, ReviewThread[]>();
    for (const thread of props.review.unplaced()) files.set(thread.path, [...(files.get(thread.path) ?? []), thread]);
    return [...files];
  };
  return props.review.unplaced().length > 0 ? (
    <View class="shrink-0 flex-col border-b border-border-60">
      <View role="button" accessibilityLabel="Conversations not on the current diff" accessibilityState={{ expanded: open() }} onPress={() => toggleWithLayout(COLLAPSE_MS, () => open.set(!open()))} class="flex-row items-center gap-1.5 px-4 py-2">
        <Text class="text-xs text-muted-foreground">{props.more() ? "Conversations not on the diff loaded so far" : "Conversations not on the current diff"}</Text>
        <ChevronTurn open={open}><PRIcon name="chevron-right" size={14} /></ChevronTurn>
        <Text class="text-xs text-muted-foreground">{String(props.review.unplaced().length)}</Text>
      </View>
      <View class="overflow-hidden">{open() ? (
        <Scroll class="max-h-64" contentClass="gap-3 px-4 pb-3">
          <Each of={byPath()} key={(entry: [string, ReviewThread[]]) => entry[0]}>
            {(entry) => (
              <View class="flex-col">
                <Text class="truncate px-3 text-xs text-muted-foreground" tooltip={tip(entry()[0])}>{entry()[0]}</Text>
                <View class="mt-1 flex-col gap-2">
                  <Each of={entry()[1]} key={(thread: ReviewThread) => thread.id}>
                    {(thread) => (
                      <View class="flex-col">
                        {thread().line === null ? null : <Text class="px-3 text-xs text-muted-foreground">{`Line ${thread().line}`}</Text>}
                        <ReviewThreadCard thread={thread()} actions={props.actions} canReply={props.review.canReply} canResolve={() => props.review.canResolve(thread())} canReact={props.review.canReact} now={props.now} {...(props.onFixFinding ? { onFix: () => props.onFixFinding!({ kind: "thread", thread: thread() }), ...(props.fixLabel ? { fixLabel: props.fixLabel } : {}) } : {})} {...(props.onAddToChat ? { onAddToChat: props.onAddToChat } : {})} />
                      </View>
                    )}
                  </Each>
                </View>
              </View>
            )}
          </Each>
        </Scroll>
      ) : null}</View>
    </View>
  ) : null;
}

/** DiffPanelLoadingState: a file header and a few code lines standing in for the diff. */
function DiffLoading(props: { label: string }) {
  const bar = (width: string) => <View class={`h-2.5 rounded-full bg-muted-50 ${width}`} />;
  return (
    <View class="min-h-0 flex-1 flex-col bg-background" accessibilityLabel={props.label}>
      <View class="h-9 flex-row items-center gap-2 border-b border-border-60 bg-muted-30 px-3">{bar("w-48")}</View>
      <View class="flex-col gap-2 px-3 py-3">{bar("w-64")}{bar("w-96")}{bar("w-40")}</View>
      <View class="h-9 flex-row items-center gap-2 border-b border-border-60 bg-muted-30 px-3">{bar("w-32")}</View>
      <View class="h-9 flex-row items-center gap-2 border-b border-border-60 bg-muted-30 px-3">{bar("w-56")}</View>
      {/* reference: <span class="sr-only">{label}</span>; NSH has no sr-only, so the label lives on the container's accessibilityLabel only */}
    </View>
  );
}

export function PullRequestCodeTab(props: {
  code: PullRequestCodeModel;
  review: PullRequestReviewModel;
  actions: PullRequestActionsModel;
  now: () => number;
  provider: string;
  url: string;
  /** The pull request's number, for the file tree's label. */
  number: number;
  /** The pull request's commits (the scope selector lists them newest first). */
  commits: () => readonly { oid: string; headline: string; committedDate: string }[];
  onOpenHost: (url: string) => void;
  /** "Add to agent": a thread's composer gets the request and the selected lines (the host may take no inline comments). */
  /** "Fix in a thread" on a review conversation. */
  onFixFinding?: (finding: PullRequestFinding) => void;
  /** Absent where there is no composer beside the panel to add a conversation to. */
  onAddToChat?: (thread: ReviewThread) => void;
  fixLabel?: () => string;
  onAddToAgent?: (selection: { path: string; side: "old" | "new"; startLine: number; endLine: number; text: string }, request: string) => void;
}) {
  const code = props.code;
  const providerName = props.provider === "gitlab" ? "GitLab" : props.provider === "bitbucket" ? "Bitbucket" : "GitHub";
  const term = () => changeRequestTerm(props.provider);
  const scoped = () => code.commit() !== null;
  const canSelect = () => !scoped() && (props.review.canComment() || props.onAddToAgent !== undefined);
  /** Sends the text and the selected lines to the agent, then closes the form. */
  const addToAgent = (body: string) => {
    const selection = props.review.excerpt();
    props.review.cancel();
    if (selection) props.onAddToAgent?.(selection, body);
  };
  let diff: DiffViewRef | null = null;
  const diffReady = signal(false);
  // The diff's files, each with its own patch as the host sent it (what the separators' gaps count from).
  const fileParts = computed(() => splitPatchFiles(code.patch()).map((raw) => {
    const meta = patchFiles(raw)[0];
    return { path: meta?.path ?? "", previousPath: meta?.oldPath ?? null, raw };
  }));
  // createPullRequestDiffFileContentsLoader: a file's two texts, fetched on the first press of one of its separators.
  const fileContext = createDiffContextState((path) => {
    const part = untracked(fileParts).find((entry) => entry.path === path);
    if (!part) return Promise.reject(new Error("Diff file contents are unavailable for this selection."));
    return code.diffFileContents({ changeType: diffChangeType(part, part.raw), oldPath: part.previousPath ?? part.path, newPath: part.path }).then(readDiffFileContents);
  });
  effect(() => { void code.scopeKey(); void code.ignoreWhitespace(); untracked(() => fileContext.reset()); });
  /** The patch drawn: every file's revealed context spliced in. */
  const drawnPatch = computed(() => {
    const parts = fileParts();
    if (parts.length === 0) return code.patch();
    return `${parts.map((part) => (part.path ? fileContext.patchFor(part.path, part.raw) : part.raw).replace(/\n+$/u, "")).join("\n")}\n`;
  });
  const drawnHunks = computed(() => hunkIndex(drawnPatch()));
  // CodeViewSearch: Cmd+F over the diff opens its find panel; the DiffView paints and counts the matches.
  const diffFind = createDiffFindState();
  const pointerInDiff = signal(false);
  registerCommand("chat.find", () => { if (!pointerInDiff() || code.pages().length === 0) return false; diffFind.open.set(true); });
  // The host's count (onSearchChange: folded files hold none); the patch's own count until it reports.
  const hostCount = signal<number | null>(null);
  effect(() => { void diffFind.params(); void drawnPatch(); hostCount.set(null); });
  const matchCount = () => (!diffFind.open() ? 0 : hostCount() ?? countInPatch(drawnPatch(), diffFind.params(), layout() === "split"));
  /** DiffView numbers its separators across the whole patch, one per hunk header: gap `g` is above a file's local hunk. */
  const separator = (gap: number) => {
    // trailingSeparators (host patch 0011): gaps past the hunk headers are the files' trailing separators.
    if (gap >= drawnHunks().length) {
      const part = fileParts()[gap - drawnHunks().length];
      if (!part) return <View class="h-0" />;
      const all = fileContext.gapsFor(part.path, part.raw);
      const tail = all[all.length - 1];
      const expandable = canHydrateContext(diffChangeType(part, part.raw), part.raw);
      if (!tail || tail.lines === 0 || !expandable) return <View class="h-0" />;
      return <DiffContextSeparator lines={tail.lines} first={false} last expandable onExpand={(action) => fileContext.expand(part.path, part.raw, tail.gap, action)} />;
    }
    const at = drawnHunks()[gap];
    const part = at ? fileParts()[at.file] : undefined;
    const entry = part && at ? fileContext.gapsFor(part.path, part.raw)[at.hunk] : undefined;
    if (!part || !entry || entry.lines === 0) return <View class="h-0" />;
    const expandable = canHydrateContext(diffChangeType(part, part.raw), part.raw);
    return <DiffContextSeparator lines={entry.lines} first={entry.first} last={false} expandable={expandable} onExpand={(action) => fileContext.expand(part.path, part.raw, entry.gap, action)} />;
  };
  const width = signal(0);
  const rowWidth = signal(0);
  const layout = () => (settingValue("diffLayout") === "split" ? "split" : "stacked");
  const orderedCommits = () => [...props.commits()].sort((left, right) => Date.parse(right.committedDate) - Date.parse(left.committedDate));
  const omittedStats = () => new Map(code.omitted().map((file) => [file.path, file] as const));

  // Folding: choices are relative to the toolbar's "Collapse all files" (or the diff settings' default), so files of
  // later pages inherit it; a new scope starts from the default again.
  const foldOverride = signal<DiffFoldOverride>(null);
  const toggled = signal<ReadonlySet<string>>(new Set());
  const effectiveOverride = (): DiffFoldOverride => foldOverride() ?? (settingValue("diffFilesCollapsed") === true ? "folded" : "expanded");
  const filePaths = () => code.files().map((file) => file.path);
  const collapsed = (path: string) => isFileDiffCollapsed(path, effectiveOverride(), toggled());
  const allCollapsed = () => filePaths().length > 0 && filePaths().every(collapsed);
  const toggleFile = (path: string) => toggled.update((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  const toggleAll = () => { foldOverride.set(allCollapsed() ? "expanded" : "folded"); toggled.set(new Set()); };
  let lastScope = "";
  effect(() => {
    const key = code.scopeKey();
    if (key === lastScope) return;
    lastScope = key;
    foldOverride.set(null);
    toggled.set(new Set());
    props.review.cancel();
  });
  // A new patch (a page arrived, whitespace mode changed) shows every file open again: fold the ones that are folded.
  effect(() => {
    void drawnPatch();
    void toggled();
    void foldOverride();
    void diffReady();
    const view = diff;
    if (!view) return;
    const wanted = new Set(filePaths().filter(collapsed));
    untracked(() => { for (const path of filePaths()) { if (wanted.has(path)) view.collapseFile(path); else view.expandFile(path); } });
  });
  // Whitespace mode and scope change the lines a draft was anchored to.
  effect(() => {
    void code.ignoreWhitespace();
    void code.commit();
    untracked(() => props.review.cancel());
  });

  function revealPath(path: string) {
    toggled.update((current) => toggleFileDiffFoldForViewed(path, false, effectiveOverride(), current));
    setTimeout(() => { diff?.expandFile(path); diff?.scrollToFile(path); }, 0);
  }
  // A file the Guide asked for pages in until it loads, then unfolds and scrolls to it.
  let answered: number | null = null;
  effect(() => {
    const request = code.reveal();
    void code.patch();
    void code.status();
    void diffReady();
    if (!request || answered === request.nonce) return;
    untracked(() => {
      if (!filePaths().includes(request.path)) {
        if (code.nextCursor() !== null && code.status() === "loaded") void code.loadMore();
        return;
      }
      answered = request.nonce;
      revealPath(request.path);
    });
  });

  function toggleViewed(file: DiffFile, extendRange: boolean) {
    const next = !code.isViewed(file.path);
    const range = code.rangeFor(file.path, extendRange);
    toggled.update((current) => range.reduce((acc, path) => toggleFileDiffFoldForViewed(path, next, effectiveOverride(), acc), current));
    void code.setViewed(file.path, next, extendRange);
  }

  const header = (file: DiffFile) => {
    const stale = () => code.isStale(file.path);
    const viewed = () => code.isViewed(file.path);
    const counts = () => {
      const withheld = omittedStats().get(file.path);
      return file.added === 0 && file.deleted === 0 && withheld ? { added: withheld.additions, deleted: withheld.deletions } : { added: file.added, deleted: file.deleted };
    };
    return (
      <View class="h-9 flex-row items-center gap-2 border-b border-border-60 bg-muted-30 px-3" accessibilityLabel={`File ${file.path}`}>
        <View role="button" accessibilityLabel={file.collapsed ? "Expand diff" : "Collapse diff"} accessibilityState={{ expanded: !file.collapsed }} onPress={() => toggleFile(file.path)} class="min-w-0 flex-1 flex-row items-center gap-2 self-stretch">
          <View class="size-5 shrink-0 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out">
            <PRIcon name={file.collapsed ? "chevron-right" : "chevron-down"} size={14} />
          </View>
          <Text class="min-w-0 shrink truncate font-mono text-xs text-foreground">{file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}</Text>
          <View class="flex-1" />
        </View>
        {counts().added === 0 && counts().deleted === 0 ? null : (
          <View class="shrink-0 flex-row items-baseline gap-1">
            <Text class={`font-mono text-2xs ${diffAdditionClass("text-success")}`}>{`+${formatCount(counts().added)}`}</Text>
            <Text class={`font-mono text-2xs ${diffDeletionClass("text-destructive")}`}>{`-${formatCount(counts().deleted)}`}</Text>
          </View>
        )}
        {code.viewedEnabled() ? (
          <View
            role="checkbox"
            accessibilityLabel={stale() ? "Changed" : "Viewed"}
            accessibilityState={{ checked: viewed() }}
            onPress={(event) => toggleViewed(file, event?.modifiers?.shift === true)}
            class="h-6 w-18 shrink-0 flex-row items-center gap-1.5"
          >
            <View class={viewed() ? "size-4 items-center justify-center rounded-sm border border-primary bg-primary" : "size-4 items-center justify-center rounded-sm border border-input"}>
              {viewed() ? <PRIcon name="check" size={12} /> : null}
            </View>
            {stale() ? <Text class="text-2xs text-warning-foreground" tooltip={tip("This file has been pushed to since you marked it viewed.")}>Changed</Text> : <Text class="text-2xs text-muted-foreground">Viewed</Text>}
          </View>
        ) : null}
      </View>
    );
  };

  const toolbar = () => (
    <View class="h-10 min-h-10 shrink-0 flex-row items-center justify-between gap-2 border-b border-border-60 bg-background px-4" onLayout={(event) => width.set(event.bounds.size.width)}>
      <View class="min-w-0 flex-1 flex-row items-center gap-3">
        {orderedCommits().length > 0 ? <DiffScopeMenu commits={orderedCommits().map((entry) => ({ oid: entry.oid, headline: entry.headline }))} commit={code.commit} onSelect={(oid) => code.selectedCommit.set(oid)} /> : null}
        <View class="min-w-0 flex-row items-center gap-1.5">
          <Text class="shrink-0 text-xs text-muted-foreground tabular-nums">{`${code.files().length} ${code.files().length === 1 ? "file" : "files"}${code.nextCursor() === null ? "" : "+"}`}</Text>
          {code.hiddenTestFiles() > 0 ? (
            <>
              <MetaDot />
              <View accessibilityLabel="Show hidden test files" role="button" onPress={() => setHideTestFiles(false)}>
                <Text class="text-xs text-primary">{`${code.hiddenTestFiles()} test ${code.hiddenTestFiles() === 1 ? "file" : "files"} hidden`}</Text>
              </View>
            </>
          ) : null}
          {code.viewedEnabled() && code.files().length > 0 ? (
            <>
              <MetaDot />
              <View class="min-w-0 flex-row items-center gap-1">
                <Text class="shrink-0 text-xs text-muted-foreground tabular-nums">{`${code.viewed()} / ${code.files().length}`}</Text>
                <Text class="truncate text-xs text-muted-foreground">{code.viewedStore() === "environment" ? `viewed in ${APP_BASE_NAME}` : "viewed"}</Text>
                {code.viewedStore() === "environment" ? <NoteIcon icon="info" hostIcon label="These ticks are kept here, not on the host" tooltip="This host keeps no shared record of which files you have read, so these ticks are kept by this environment. They follow you between the apps connected to it, but the host's own web UI will not show them." /> : null}
                {code.viewedError() ? <NoteIcon icon="triangle-alert" label="Your ticks could not be read" tooltip={`The boxes below are whatever was last read, and empty if nothing has been read yet. ${code.viewedError()}`} /> : null}
                {code.viewedTruncated() ? <NoteIcon icon="triangle-alert" label="This count covers only part of the change" tooltip="This change has more files than the host will report ticks for in one read, so the count is short and some boxes below start empty." /> : null}
              </View>
            </>
          ) : null}
          {code.withheld() ? (
            <>
              <MetaDot />
              <NoteIcon icon="triangle-alert" label="Some of this diff was not shown" tooltip="The host withheld part of this diff: a binary file, or a change too large to inline." />
            </>
          ) : null}
          {scoped() && props.review.canComment() ? (
            <>
              <MetaDot />
              <NoteIcon icon="message-square-off" label="Line comments are written from the whole change" tooltip="A comment is anchored to the whole change, so switch to All commits to write one." />
            </>
          ) : null}
        </View>
      </View>
      <View class="shrink-0 flex-row items-center gap-1">
        {width() < TOOLBAR_WIDE_PX ? (
          <DiffOptionsMenu
            ignoreWhitespace={code.ignoreWhitespace}
            wrap={code.wrap}
            layout={layout}
            onIgnoreWhitespace={(value) => code.ignoreWhitespace.set(value)}
            onWrap={(value) => code.wrap.set(value)}
            onLayout={(value) => updateSetting("diffLayout", value)}
          />
        ) : (
          <View class="flex-row items-center gap-1">
            <IconToggle label={code.ignoreWhitespace() ? "Show whitespace changes" : "Hide whitespace changes"} icon="pilcrow" pressed={code.ignoreWhitespace()} onPress={() => code.ignoreWhitespace.set(!code.ignoreWhitespace())} />
            <View role="group" accessibilityLabel="Diff layout" class="h-6 flex-row items-center rounded-md bg-segmented-track p-0.5">
              <View role="button" accessibilityLabel="Stacked diff view" accessibilityState={{ pressed: layout() === "stacked" }} onPress={() => updateSetting("diffLayout", "stacked")} class={`h-5 w-7 items-center justify-center rounded transition-colors duration-150 ease-in-out ${layout() === "stacked" ? "bg-segmented-active" : ""}`}><HIcon name="rows-3" size={14} /></View>
              <View role="button" accessibilityLabel="Split diff view" accessibilityState={{ pressed: layout() === "split" }} onPress={() => updateSetting("diffLayout", "split")} class={`h-5 w-7 items-center justify-center rounded transition-colors duration-150 ease-in-out ${layout() === "split" ? "bg-segmented-active" : ""}`}><HIcon name="columns-2" size={14} /></View>
            </View>
            <IconToggle label={code.wrap() ? "Disable diff line wrapping" : "Enable diff line wrapping"} tooltip={code.wrap() ? "Disable line wrapping" : "Enable line wrapping"} icon="text-wrap" pressed={code.wrap()} onPress={() => code.wrap.set(!code.wrap())} />
          </View>
        )}
        {filePaths().length > 0 ? <IconToggle label={allCollapsed() ? "Expand all files" : "Collapse all files"} icon={allCollapsed() ? "chevrons-up-down" : "chevrons-down-up"} onPress={toggleAll} /> : null}
        {code.testFileCount() > 0 ? <IconToggle label={code.hideTests() ? "Show test files" : "Hide test files"} icon="flask-conical-off" pressed={code.hideTests()} onPress={() => setHideTestFiles(!code.hideTests())} /> : null}
        {filePaths().length > 0 ? <IconToggle label={fileTreeOpen() ? "Hide file tree" : "Show file tree"} icon="folder-tree" pressed={fileTreeOpen()} onPress={() => setFileTreeOpen(!fileTreeOpen())} /> : null}
      </View>
    </View>
  );

  const retry = () => void (code.status() === "error" ? code.reload() : code.loadMore());
  /** The rest of the diff: loading, failed, or one press away. */
  const pagingNote = () => (code.nextCursor() === null ? null : (
    <View class="shrink-0 flex-row items-center justify-center gap-2 border-t border-border-60 p-2" accessibilityLabel="Rest of the diff">
      {code.status() === "error" ? <Text class="text-xs text-muted-foreground">The rest of this diff could not be loaded.</Text> : null}
      <View accessibilityLabel={code.status() === "error" ? "Retry" : "Load more files"} role="button" onPress={retry} class="h-6 items-center justify-center rounded-md border border-border px-2 hover:bg-accent-50">
        <Text class="text-xs text-foreground">{code.status() === "error" ? "Retry" : code.status() === "loading" ? "Loading more files..." : "Load more files"}</Text>
      </View>
    </View>
  ));

  const emptyText = () => (scoped() ? "This commit has no file changes." : `This ${term()} has no file changes.`);

  return (
    <View class="min-h-0 flex-1 flex-col" accessibilityLabel="Pull request code">
      {code.status() !== "idle" ? toolbar() : null}
      {code.status() === "error" && code.pages().length === 0 ? (
        <PullRequestDiffUnavailableState error={code.error()} providerName={providerName} term={term()} onRetry={() => void code.reload()} onOpenHost={() => props.onOpenHost(props.url)} />
      ) : null}

      {code.status() === "loading" && code.pages().length === 0 ? <DiffLoading label={`Loading ${term()} diff...`} /> : null}

      {code.pages().length > 0 ? (
        <View class="min-h-0 flex-1 flex-col">
          <OrphanThreads review={props.review} actions={props.actions} now={props.now} more={() => code.nextCursor() !== null} {...(props.onFixFinding ? { onFixFinding: props.onFixFinding } : {})} {...(props.fixLabel ? { fixLabel: props.fixLabel } : {})} {...(props.onAddToChat ? { onAddToChat: props.onAddToChat } : {})} />
          {code.files().length === 0 && code.nextCursor() === null ? <View class="px-4 py-5"><Text class="text-sm text-muted-foreground">{emptyText()}</Text></View> : (
            <View class="min-h-0 flex-1 flex-row" onLayout={(event) => rowWidth.set(event.bounds.size.width)}>
              <View class="relative min-h-0 min-w-0 flex-1 flex-col" onMouseEnter={() => pointerInDiff.set(true)} onMouseLeave={() => pointerInDiff.set(false)}>
                <DiffFindBar state={diffFind} count={matchCount} onReveal={(index) => (diff as unknown as { revealSearchMatch?: (index: number) => void } | null)?.revealSearchMatch?.(index)} />
                <DiffView
                  patch={drawnPatch()}
                  {...({
                    search: diffFind.open() && diffFind.params().text !== "" ? diffFind.params().text : null,
                    searchCaseSensitive: diffFind.params().caseSensitive,
                    searchWholeWord: diffFind.params().wholeWord,
                    searchRegex: diffFind.params().regex,
                    searchCurrent: diffFind.current(),
                    trailingSeparators: true,
                    onSearchChange: (event: { result: { count: number } }) => hostCount.set(event.result.count),
                  } as object)}
                  renderSeparator={(value) => separator(value.gap)}
                  layout={layout() === "split" ? "split" : "unified"}
                  softWrap={code.wrap()}
                  annotations={props.review.annotations()}
                  renderAnnotation={(annotation) => {
                    const group = () => props.review.group(annotation.id);
                    return (
                      <View class="flex-col py-1">
                        <Each of={group()?.threads ?? []} key={(thread: ReviewThread) => thread.id}>
                          {(thread) => <ReviewThreadCard thread={thread()} actions={props.actions} canReply={props.review.canReply} canResolve={() => props.review.canResolve(thread())} canReact={props.review.canReact} now={props.now} {...(props.onFixFinding ? { onFix: () => props.onFixFinding!({ kind: "thread", thread: thread() }), ...(props.fixLabel ? { fixLabel: props.fixLabel } : {}) } : {})} {...(props.onAddToChat ? { onAddToChat: props.onAddToChat } : {})} />}
                        </Each>
                        <Each of={[...(group()?.pending ?? [])]} key={(comment: PendingReviewComment) => comment.id}>
                          {(comment) => <PendingReviewCommentCard comment={comment()} onRemove={() => props.review.removePending(comment().id)} />}
                        </Each>
                        {group()?.draft && props.review.draft() && canSelect() ? (
                          <DiffCommentForm rangeLabel={draftRangeLabel(props.review.draft()!)} submitLabel={props.review.canCommentOnLines() ? "Add to review" : "Add to agent"} completion={props.review.canCommentOnLines() ? props.actions.completion() : null} onCancel={props.review.cancel}
                            onComment={props.review.canCommentOnLines() ? props.review.addPending : addToAgent}
                            {...(props.review.canCommentOnLines() && props.onAddToAgent ? { secondaryAction: { label: "Add to agent", onAction: addToAgent } } : {})} />
                        ) : null}
                      </View>
                    );
                  }}
                  renderAddAnnotation={canSelect() ? (range) => (
                    <View role="button" accessibilityLabel="Add a comment on this line" onPress={() => { props.review.begin({ side: range.side, start: range.start, end: range.end }); }} class="size-4 items-center justify-center rounded-sm bg-primary">
                      <PRIcon name="plus" size={12} />
                    </View>
                  ) : undefined}
                  renderFileHeader={header}
                  onScroll={(event) => { if (code.nextCursor() !== null && code.status() === "loaded" && event.offset.y + event.size.height >= event.contentSize.height - 240) void code.loadMore(); }}
                  ref={(node: DiffViewRef) => { diff = node; diffReady.set(true); }}
                  classes={diffViewColorClasses()}
                  class="min-h-0 flex-1"
                />
                {pagingNote()}
              </View>
              {fileTreeOpen() ? (
                <PullRequestFileTree
                  files={() => code.files()}
                  rowWidth={() => rowWidth()}
                  ariaLabel={`${term() === "merge request" ? "Merge request" : "Pull request"} #${props.number} files`}
                  onSelectFile={revealPath}
                  footer={() => (code.nextCursor() === null ? null : (
                    <View class="shrink-0 border-t border-border-60 p-2">
                      <View accessibilityLabel={code.status() === "error" ? "Retry" : "Load more files"} role="button" onPress={retry} class="h-6 items-center justify-center rounded-md border border-border hover:bg-accent-50">
                        <Text class="text-xs text-foreground">{code.status() === "error" ? "Retry" : code.status() === "loading" ? "Loading more files..." : "Load more files"}</Text>
                      </View>
                    </View>
                  ))}
                />
              ) : null}
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}
