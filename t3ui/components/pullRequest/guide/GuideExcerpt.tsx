// GuideExcerpt.tsx: one excerpt of a guide stop: its caption, and the lines of the pull request's diff that fall in the
// range, drawn by the diff view in a bordered block whose header names the file, says how much of its diff is shown and opens
// the file in Code. Lines can be commented on (added to the review, or asked about) and carry the stop's note markers.
import { Text, View } from "nsh";
import { DiffView } from "nsh/base";
import { HIcon } from "../../header/HeaderIcons";
import { PRIcon } from "../PRIcon";
import { createPullRequestReviewModel } from "../pullRequestReviewModel";
import { DiffCommentForm, draftRangeLabel, PendingReviewCommentCard } from "../PullRequestReviewAnnotation";
import type { PullRequestActionsModel } from "../pullRequestActionsModel";
import type { PullRequestDetailData } from "../pullRequestDetail.logic";
import type { PullRequestRefInput } from "../pullRequestDiff.logic";
import { groupId, type PendingReviewComment, type SelectionExcerpt } from "../pullRequestReview.logic";
import type { ExcerptNoteLine } from "../pullRequestGuide.logic";
import { excerptPatch, type Excerpt } from "./excerptPatch";
import { diffViewColorClasses } from "../../diff/diffColorScheme";
import { canHydrateContext, diffChangeType, parseFilePatch, readDiffFileContents, type DiffFileContents } from "../../diff/diffContext";
import { createDiffContextState } from "../../diff/diffContextState";
import { DiffContextSeparator } from "../../diff/DiffContextSeparator";
import { patchFiles } from "../pullRequestDiff.logic";

/** GuideExcerpt's excerptLoader: an excerpt drawn from one hunk expands against an old side that matches it (other
 * hunks' changes would otherwise shift its context), so the slice is renumbered with its old start at its new start and
 * the old text is as long as the new one plus the hunk's own difference. */
export function excerptExpansion(slice: string): { patch: string; adapt: (loaded: DiffFileContents) => DiffFileContents } | null {
  const parsed = parseFilePatch(slice);
  if (parsed.hunks.length !== 1) return null;
  const hunk = parsed.hunks[0]!;
  const newFirst = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
  const oldStart = hunk.oldLines === 0 ? newFirst - 1 : newFirst;
  const header = `@@ -${oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.header ? ` ${hunk.header}` : ""}`;
  const patch = `${[...parsed.head, header, ...hunk.lines].join("\n")}\n`;
  return {
    patch,
    adapt: (loaded) => {
      const newCount = loaded.newContents === "" ? 0 : loaded.newContents.replace(/\n$/u, "").split("\n").length;
      const oldCount = Math.max(0, newCount + hunk.oldLines - hunk.newLines);
      return { oldContents: Array.from({ length: oldCount }, () => "").join("\n"), newContents: loaded.newContents };
    },
  };
}

/** Rows are 20pt tall, the diff view's default. */
export const EXCERPT_ROW_HEIGHT = 20;

/** The lines of an excerpt can be commented on when the host takes inline comments, or asked about when an agent can be reached. */
export interface ExcerptCommenting {
  detail: () => PullRequestDetailData | null;
  ref: () => PullRequestRefInput | null;
  actions: PullRequestActionsModel;
  onAskAgent: ((selection: SelectionExcerpt, request: string) => void) | null;
}

/** GuideNoteMarker: the lettered dot of a note. */
export function GuideNoteMarker(props: { marker: string }) {
  return (
    <View class="size-[18px] shrink-0 items-center justify-center rounded-full bg-muted-50" accessibilityLabel={`Note ${props.marker}`}>
      <Text class="text-2xs font-medium text-info-foreground">{props.marker}</Text>
    </View>
  );
}

function Header(props: { path: string; shown: number; total: number; side: string; onOpenFile: (path: string) => void }) {
  return (
    <View class="h-9 flex-row items-center gap-2 border-b border-border-60 bg-muted-30 px-3" accessibilityLabel={`File ${props.path}`}>
      <Text class="min-w-0 shrink truncate font-mono text-xs text-foreground">{props.path}</Text>
      <View class="flex-1" />
      <Text class="shrink-0 text-xs text-muted-foreground tabular-nums">{`${props.side === "old" ? "removed code, " : ""}showing ${props.shown} of ${props.total} diff lines`}</Text>
      <View role="button" accessibilityLabel={`Open ${props.path} in Code`} onPress={() => props.onOpenFile(props.path)} class="size-6 shrink-0 items-center justify-center rounded-md hover:bg-accent-50">
        <HIcon name="arrow-up-right" size={12} />
      </View>
    </View>
  );
}

export function GuideExcerpt(props: {
  excerpt: Excerpt & { caption: string };
  patch: () => string;
  loading: () => boolean;
  error: () => string;
  notes?: readonly ExcerptNoteLine[];
  commenting?: ExcerptCommenting | null;
  onOpenFile?: (path: string) => void;
  /** pullRequests.diffFileContents for one file (the guide's loader); absent, the excerpt's lines do not expand. */
  loadContents?: (input: { changeType: string; oldPath: string; newPath: string }) => Promise<unknown>;
}) {
  const excerpt = props.excerpt;
  const baseSlice = () => (props.patch() ? excerptPatch(props.patch(), excerpt) : null);
  const expansion = () => { const found = baseSlice(); return found && props.loadContents ? excerptExpansion(found.patch) : null; };
  const context = createDiffContextState(async () => {
    const found = expansion();
    const meta = found ? patchFiles(found.patch)[0] : undefined;
    if (!found || !meta || !props.loadContents) throw new Error("Diff file contents are unavailable for this selection.");
    const file = { path: meta.path, previousPath: meta.oldPath };
    return found.adapt(readDiffFileContents(await props.loadContents({ changeType: diffChangeType(file, found.patch), oldPath: meta.oldPath ?? meta.path, newPath: meta.path })));
  });
  /** The slice drawn: the excerpt's rows, with any context its separators revealed. */
  const slice = () => {
    const found = baseSlice();
    const expandable = expansion();
    if (!found || !expandable) return found;
    const drawn = context.patchFor(excerpt.path, expandable.patch);
    return { ...found, patch: drawn, shown: drawn.split("\n").filter((line) => /^[ +-]/u.test(line) && !/^(---|\+\+\+) /u.test(line)).length };
  };
  const separator = (gap: number) => {
    const expandable = expansion();
    if (!expandable) return <View class="h-0" />;
    const all = context.gapsFor(excerpt.path, expandable.patch);
    const entry = gap === 0 ? all[0] : undefined;
    const meta = patchFiles(expandable.patch)[0];
    const hydrates = meta ? canHydrateContext(diffChangeType({ path: meta.path, previousPath: meta.oldPath }, expandable.patch), expandable.patch) : false;
    if (!entry || entry.lines === 0 || !hydrates) return <View class="h-0" />;
    return <DiffContextSeparator lines={entry.lines} first={entry.first} last={false} expandable onExpand={(action) => context.expand(excerpt.path, expandable.patch, entry.gap, action)} />;
  };
  const tail = () => {
    const expandable = expansion();
    if (!expandable) return null;
    const all = context.gapsFor(excerpt.path, expandable.patch);
    const last = all[all.length - 1];
    return last && last.lines !== 0 ? last : null;
  };
  const commenting = props.commenting ?? null;
  const review = createPullRequestReviewModel({
    ref: () => commenting?.ref() ?? null,
    patch: () => slice()?.patch ?? "",
    detail: () => commenting?.detail() ?? null,
    activity: () => null,
  });
  const canComment = () => review.canComment();
  const interactive = () => commenting !== null && (canComment() || commenting.onAskAgent !== null) && review.draft() === null;
  const askAgent = (request: string) => {
    const selection = review.excerpt();
    review.cancel();
    if (selection) commenting?.onAskAgent?.(selection, request);
  };
  // The note markers sit on the lines their notes name, in the annotations beside the review's own.
  const noteLines = () => {
    const side = excerpt.side === "old" ? "old" as const : "new" as const;
    const out = new Map<string, { side: "old" | "new"; index: number; markers: ExcerptNoteLine["markers"] }>();
    for (const note of props.notes ?? []) {
      const entry = review.lines().find((candidate) => (side === "old" ? candidate.oldLine : candidate.newLine) === note.line && (side === "old" ? candidate.oldIndex : candidate.newIndex) >= 0);
      if (!entry) continue;
      const index = side === "old" ? entry.oldIndex : entry.newIndex;
      out.set(groupId(side, index), { side, index, markers: note.markers });
    }
    return out;
  };
  const annotations = () => {
    const all = new Map(review.annotations().map((annotation) => [annotation.id, annotation] as const));
    for (const [id, note] of noteLines()) if (!all.has(id)) all.set(id, { id, side: note.side, line: note.index });
    return [...all.values()];
  };
  return (
    <View class="flex-col gap-1.5" accessibilityLabel={`Excerpt ${excerpt.path}`}>
      {excerpt.caption.trim() ? <Text class="text-xs text-muted-foreground">{excerpt.caption}</Text> : null}
      {slice() ? (
        <View class="min-w-0 flex-col overflow-hidden rounded-lg border border-border-60">
          <DiffView
            patch={slice()!.patch}
            layout="unified"
            contextLines={0}
            renderSeparator={(value) => separator(value.gap)}
            annotations={annotations()}
            renderFileHeader={() => <Header path={excerpt.path} shown={slice()!.shown} total={slice()!.total} side={excerpt.side} onOpenFile={(path) => props.onOpenFile?.(path)} />}
            renderAnnotation={(annotation) => {
              const markers = () => noteLines().get(annotation.id)?.markers ?? [];
              const group = () => review.group(annotation.id);
              return (
                <View class="flex-col">
                  {markers().length > 0 ? (
                    <View class="flex-row flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1">
                      <Each of={[...markers()]} key={(entry: { marker: string; title: string }) => entry.marker}>
                        {(entry) => <View class="flex-row items-center gap-1.5"><GuideNoteMarker marker={entry().marker} /><Text class="text-xs text-foreground">{entry().title}</Text></View>}
                      </Each>
                    </View>
                  ) : null}
                  <Each of={[...(group()?.pending ?? [])]} key={(comment: PendingReviewComment) => comment.id}>
                    {(comment) => <PendingReviewCommentCard comment={comment()} onRemove={() => review.removePending(comment().id)} />}
                  </Each>
                  {group()?.draft && review.draft() && commenting ? (
                    <DiffCommentForm
                      rangeLabel={draftRangeLabel(review.draft()!)}
                      placeholder={canComment() ? "Add a comment…" : "Ask the agent about these lines…"}
                      submitLabel={canComment() ? "Add to review" : "Ask agent"}
                      completion={canComment() ? commenting.actions.completion() : null}
                      onCancel={review.cancel}
                      onComment={canComment() ? review.addPending : askAgent}
                      {...(canComment() && commenting.onAskAgent ? { secondaryAction: { label: "Ask agent", onAction: askAgent } } : {})}
                    />
                  ) : null}
                </View>
              );
            }}
            renderAddAnnotation={interactive() ? (range) => (
              <View role="button" accessibilityLabel="Add a comment on this line" onPress={() => { review.begin({ side: range.side, start: range.start, end: range.end }); }} class="size-4 items-center justify-center rounded-sm bg-primary"><PRIcon name="plus" size={12} /></View>
            ) : undefined}
            classes={diffViewColorClasses()}
            class="w-full"
            style={{ height: slice()!.shown * EXCERPT_ROW_HEIGHT + 36 + (review.draft() ? 160 : 0) }}
          />
          {tail() ? <DiffContextSeparator lines={tail()!.lines} first={false} last expandable onExpand={(action) => context.expand(excerpt.path, expansion()!.patch, tail()!.gap, action)} /> : null}
        </View>
      ) : props.error() ? (
        <Text class="rounded-lg border border-border-60 px-3 py-2 text-xs text-muted-foreground">{`The diff could not be read. ${props.error()}`}</Text>
      ) : props.loading() ? (
        <Text class="rounded-lg border border-border-60 px-3 py-2 text-xs text-muted-foreground">{`Loading ${excerpt.path}...`}</Text>
      ) : (
        <View class="flex-row items-center justify-between gap-3 rounded-lg border border-border-60 px-3 py-2">
          <Text class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{`${excerpt.path} lines ${excerpt.start}-${excerpt.end} are not in the loaded diff.`}</Text>
          <View role="button" accessibilityLabel="Open in Code" onPress={() => props.onOpenFile?.(excerpt.path)} class="h-6 shrink-0 items-center justify-center rounded-md border border-border px-2 hover:bg-accent-50"><Text class="text-xs text-foreground">Open in Code</Text></View>
        </View>
      )}
    </View>
  );
}
