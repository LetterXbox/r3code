// The Guide tab, ported from PullRequestGuideTab.tsx / GuideTour.tsx / GuideStop.tsx: a tour of the
// change, one stop at a time, in reading order, with the calls only a maintainer can make.
import { effect, keymap, Scroll, signal, Text, untracked, View } from "nsh";
import { paletteOpen } from "../../store";
import { canHydrateContext, diffChangeType, hunkIndex, readDiffFileContents } from "../diff/diffContext";
import { createDiffContextState } from "../diff/diffContextState";
import { DiffContextSeparator } from "../diff/DiffContextSeparator";
import type { ScrollRef } from "nsh";
import { PRIcon } from "./PRIcon";
import { HIcon } from "../header/HeaderIcons";
import { ChevronTurn } from "../motion/Motion";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import type { PullRequestActionsModel } from "./pullRequestActionsModel";
import type { PullRequestDetailData } from "./pullRequestDetail.logic";
import { patchFiles } from "./pullRequestDiff.logic";
import type { SelectionExcerpt } from "./pullRequestReview.logic";
import {
  GUIDE_ATTENTION_LABEL, GUIDE_FAILURE_HINT, GUIDE_NOTES_ASIDE_MIN_WIDTH, GUIDE_RAIL_MIN_WIDTH, guideFailure, guideIsStale, guideRunning, guideStepIndex, letterStopNotes, parseGuideResult,
  stopFilePaths, stopSubline, type GuideResult, type GuideStop,
} from "./pullRequestGuide.logic";
import { readableFailure } from "./pullRequestActionCopy";
import { fetchPullRequestDiff, type DiffFetchDeps, type PullRequestRefInput } from "./pullRequestDiff.logic";
import { GuideExcerpt, GuideNoteMarker, type ExcerptCommenting } from "./guide/GuideExcerpt";
import { guideStartFailed, watchGuideRun } from "./guide/guideRunCoordinator";
import { fileSection, missingPaths } from "./guide/excerptPatch";
import { DiffView } from "nsh/base";
import { diffAdditionClass, diffDeletionClass, diffViewColorClasses } from "../diff/diffColorScheme";

const NO_SEEN: ReadonlySet<number> = new Set();

export function createPullRequestGuideModel(deps: {
  request: (method: string, payload: unknown) => Promise<unknown>;
  ref: () => PullRequestRefInput | null;
  /** The diff client; without it excerpts show only their path and range. */
  http?: DiffFetchDeps;
  /** The pull request's title, for the run's ready / failed toast. */
  title?: () => string | null;
}) {
  const result = signal<GuideResult | null>(null);
  // The pull request's diff pages read so far, for the excerpts of the stop being shown.
  const patch = signal("");
  const diffLoading = signal(false);
  const diffError = signal("");
  let diffKey = "";
  let diffCursor: string | null = null;
  let diffDone = false;
  const status = signal<"idle" | "loading" | "loaded" | "error">("idle");
  const error = signal("");
  /** Where the reader is in each guide and which stops they have read, by pull request and the head the guide was written for. */
  const progress = signal<Record<string, { position: number; seen: ReadonlySet<number> }>>({});
  const writing = signal(false);
  let loadedKey = "";

  async function load() {
    const ref = deps.ref();
    if (!ref) return;
    const key = `${ref.projectId}|${ref.repository}|${ref.number}`;
    if (key !== loadedKey) result.set(null);
    loadedKey = key;
    status.set("loading");
    error.set("");
    try {
      result.set(parseGuideResult(await deps.request("pullRequests.reviewGuide", ref)));
      status.set("loaded");
    } catch (cause) {
      error.set(cause instanceof Error ? cause.message : String(cause));
      status.set("error");
    }
  }

  async function write() {
    const ref = deps.ref();
    if (!ref || writing()) return;
    writing.set(true);
    // useReviewGuideWriter: the run is watched until it settles (guideRunCoordinator), then announced.
    const before = result();
    watchGuideRun({ reference: ref, title: deps.title?.() ?? null, previousGuideAt: before?.guide?.generatedAt || null, previousFailedAt: before?.run?.tag === "Failed" ? (before.run.failedAt ?? null) : null, since: Date.now() }, deps.request);
    try {
      result.set(parseGuideResult(await deps.request("pullRequests.generateReviewGuide", ref)));
      error.set("");
    } catch (cause) {
      // useReviewGuideWriter: a refusal is only the toast (the read's own error is not the write's), with the host's words or the hint.
      guideStartFailed(ref, readableFailure(cause, "Check the review guide model in Settings → Source control."));
    } finally {
      writing.set(false);
    }
  }

  /** Reads diff pages until every path the excerpts name is in, or the diff ends. */
  async function loadExcerptDiff(excerpts: readonly { path: string }[]) {
    const ref = deps.ref();
    if (!ref || !deps.http || excerpts.length === 0 || diffLoading()) return;
    const headSha = result()?.guide?.headSha ?? "";
    const key = `${ref.projectId}|${ref.repository}|${ref.number}|${headSha}`;
    if (key !== diffKey) { diffKey = key; diffCursor = null; diffDone = false; patch.set(""); diffError.set(""); }
    if (diffDone || missingPaths(patch(), excerpts).length === 0) return;
    diffLoading.set(true);
    try {
      while (!diffDone && missingPaths(patch(), excerpts).length > 0) {
        const page = await fetchPullRequestDiff(deps.http, ref, diffCursor ? { cursor: diffCursor } : {});
        if (key !== diffKey) return;
        patch.update((all) => `${all}${all && !all.endsWith("\n") ? "\n" : ""}${page.patch}`);
        diffCursor = page.nextCursor;
        diffDone = page.nextCursor === null;
      }
    } catch (cause) {
      diffError.set(cause instanceof Error ? cause.message : String(cause));
      // A failed read is not retried by the effect that asked for it; Rewrite or a new stop tries again.
      diffDone = true;
    } finally {
      diffLoading.set(false);
    }
  }

  /** Fetches once per pull request, when the tab first shows. */
  function ensureLoaded() {
    const ref = deps.ref();
    if (ref && loadedKey !== `${ref.projectId}|${ref.repository}|${ref.number}` && status() !== "loading") void load();
  }

  const progressKey = () => {
    const ref = deps.ref();
    const head = result()?.guide?.headSha;
    return ref && head ? `${ref.projectId}|${ref.host ?? ""}|${ref.repository}|${ref.number}:${head}` : "";
  };
  const position = () => progress()[progressKey()]?.position ?? 0;
  const seen = (): ReadonlySet<number> => progress()[progressKey()]?.seen ?? NO_SEEN;
  /** The reader moves to a stop; moving forward marks the one left as read. */
  function goTo(next: number) {
    const key = progressKey();
    if (!key) return;
    const current = progress()[key] ?? { position: 0, seen: NO_SEEN };
    progress.update((all) => ({ ...all, [key]: { position: next, seen: next > current.position ? new Set(current.seen).add(current.position) : current.seen } }));
  }
  /** "Finish review": the stop being read counts as read. */
  function markRead(index: number) {
    const key = progressKey();
    if (!key) return;
    const current = progress()[key] ?? { position: 0, seen: NO_SEEN };
    progress.update((all) => ({ ...all, [key]: { ...current, seen: new Set(current.seen).add(index) } }));
  }

  /** GuideTour's createPullRequestDiffFileContentsLoader (commit: null): one file's texts for its unchanged lines. */
  function diffFileContents(input: { changeType: string; oldPath: string; newPath: string }): Promise<unknown> {
    const ref = deps.ref();
    if (!ref) return Promise.reject(new Error("Diff file contents are unavailable for this selection."));
    return deps.request("pullRequests.diffFileContents", { ...ref, ...input });
  }
  return { position, seen, goTo, markRead, result, status, error, writing, load, write, ensureLoaded, patch, diffLoading, diffError, loadExcerptDiff, diffFileContents };
}

export type PullRequestGuideModel = ReturnType<typeof createPullRequestGuideModel>;


function OutlineButton(props: { label: string; icon?: string; disabled?: boolean; onPress: () => void }) {
  return (
    <View role="button" accessibilityLabel={props.label} onPress={() => { if (!props.disabled) props.onPress(); }} class={`h-7 flex-row items-center gap-1.5 rounded-md border border-border px-2.5 ${props.disabled ? "opacity-50" : "hover:bg-accent-50"}`}>
      {props.icon ? <PRIcon name={props.icon} size={14} /> : null}
      <Text class="text-xs text-foreground">{props.label}</Text>
    </View>
  );
}

/** GuideRail: "N of M read", then a row per stop with its number (a check once read), title, "Look closely" and file count. */
function GuideRail(props: { stops: readonly GuideStop[]; position: number; seen: ReadonlySet<number>; onSelect: (index: number) => void; showCount: boolean }) {
  return (
    <View class="flex-col gap-4" accessibilityLabel="Review tour">
      {props.showCount ? <Text class="text-xs text-muted-foreground tabular-nums">{`${props.seen.size} of ${props.stops.length} read`}</Text> : null}
      <View class="flex-col gap-0.5">
        <Each of={[...props.stops]} key={(stop: GuideStop, index: number) => `${index}:${stop.title}`}>
          {(stop, index) => {
            const read = () => props.seen.has(index());
            return (
              <View role="button" accessibilityLabel={stop().title} accessibilityState={{ selected: props.position === index() }} onPress={() => props.onSelect(index())} class={`w-full flex-row items-start gap-2 rounded-md px-2 py-1.5 ${props.position === index() ? "bg-accent" : "hover:bg-accent-50"}`}>
                <View class={`size-5 shrink-0 items-center justify-center rounded-full border ${read() ? "border-success" : "border-border"}`}>
                  {read() ? <View accessibilityLabel={`Stop ${index() + 1}, read`}><PRIcon name="check" size={12} /></View> : <Text class="text-2xs text-muted-foreground tabular-nums">{String(index() + 1)}</Text>}
                </View>
                <View class="min-w-0 flex-1 flex-col gap-0.5">
                  <Text class="text-sm text-foreground">{stop().title}</Text>
                  <View class="flex-row flex-wrap items-center gap-1.5">
                    {stop().attention !== null ? <View class="rounded-md bg-warning-surface px-1.5"><Text class="text-2xs text-warning-foreground">Look closely</Text></View> : null}
                    <Text class="text-xs text-muted-foreground">{stopSubline(stop())}</Text>
                  </View>
                </View>
              </View>
            );
          }}
        </Each>
      </View>
    </View>
  );
}

function GuideNotes(props: { notes: ReturnType<typeof letterStopNotes>["lettered"] }) {
  return props.notes.length === 0 ? null : (
    <View class="min-w-0 flex-col gap-2">
      <View class="flex-row items-baseline justify-between gap-2">
        <Text class="text-xs font-medium text-foreground">Notes on this stop</Text>
        <Text class="text-xs text-muted-foreground tabular-nums">{props.notes.length === 1 ? "1 note" : `${props.notes.length} notes`}</Text>
      </View>
      <View class="flex-col gap-3">
        <Each of={[...props.notes]} key={(entry: ReturnType<typeof letterStopNotes>["lettered"][number]) => entry.marker}>
          {(entry) => (
            <View class="min-w-0 flex-row gap-2">
              <GuideNoteMarker marker={entry().marker} />
              <View class="min-w-0 flex-1 flex-col gap-0.5">
                <View class="flex-row flex-wrap items-baseline gap-x-2">
                  <Text class="text-xs font-medium text-foreground">{entry().note.title}</Text>
                  <Text class="truncate font-mono text-2xs text-muted-foreground">{`${entry().note.path.split("/").at(-1)}:${entry().note.line}`}</Text>
                </View>
                {entry().note.body.trim() ? <PullRequestMarkdown class="text-xs" text={entry().note.body} /> : null}
              </View>
            </View>
          )}
        </Each>
      </View>
    </View>
  );
}

function OtherFile(props: { file: GuideStop["files"][number]; guide: PullRequestGuideModel }) {
  const open = signal(false);
  const section = () => (props.guide.patch() ? fileSection(props.guide.patch(), props.file.path) : null);
  // GuideFileDiff: the file's diff with its loader, so the unchanged lines between and around hunks expand.
  const context = createDiffContextState(() => {
    const raw = untracked(section)?.section ?? "";
    const meta = patchFiles(raw)[0];
    if (!meta) return Promise.reject(new Error("Diff file contents are unavailable for this selection."));
    const file = { path: meta.path, previousPath: meta.oldPath };
    return props.guide.diffFileContents({ changeType: diffChangeType(file, raw), oldPath: meta.oldPath ?? meta.path, newPath: meta.path }).then(readDiffFileContents);
  });
  const raw = () => section()?.section ?? "";
  const drawn = () => context.patchFor(props.file.path, raw());
  const expandable = () => { const meta = patchFiles(raw())[0]; return meta ? canHydrateContext(diffChangeType({ path: meta.path, previousPath: meta.oldPath }, raw()), raw()) : false; };
  const separator = (gap: number) => {
    const entry = context.gapsFor(props.file.path, raw())[hunkIndex(drawn())[gap]?.hunk ?? -1];
    if (!entry || entry.lines === 0) return <View class="h-0" />;
    return <DiffContextSeparator lines={entry.lines} first={entry.first} last={false} expandable={expandable()} onExpand={(action) => context.expand(props.file.path, raw(), entry.gap, action)} />;
  };
  const stat = () => { const found = section(); return found ? patchFiles(found.section)[0] ?? null : null; };
  return (
    <View class="flex-col border-b border-border-60">
      <View role="button" accessibilityLabel={props.file.path} accessibilityState={{ expanded: open() }} onPress={() => open.set(!open())} class="w-full min-w-0 flex-row items-center gap-2 px-3 py-2 hover:bg-accent-50">
        <ChevronTurn open={open}><PRIcon name="chevron-right" size={14} /></ChevronTurn>
        <HIcon name="file" size={14} />
        <Text class="min-w-0 shrink truncate font-mono text-xs text-foreground">{props.file.path}</Text>
        {props.file.note.trim() ? <Text class="ml-auto min-w-0 shrink truncate text-xs text-muted-foreground">{props.file.note}</Text> : null}
        {stat() ? <View class="shrink-0 flex-row gap-1"><Text class={`font-mono text-xs ${diffAdditionClass("text-success")}`}>{`+${stat()!.additions}`}</Text><Text class={`font-mono text-xs ${diffDeletionClass("text-destructive")}`}>{`-${stat()!.deletions}`}</Text></View> : null}
      </View>
      {open() ? (section() ? (
        <View class="border-t border-border-60"><DiffView patch={drawn()} layout="unified" renderSeparator={(value) => separator(value.gap)} classes={diffViewColorClasses()} class="w-full" style={{ height: Math.min(480, Math.max(80, drawn().split("\n").length * 20)) }} /></View>
      ) : <Text class="px-3 py-2 text-xs text-muted-foreground">{props.guide.diffLoading() ? "Loading the diff..." : "This file is not in the loaded diff."}</Text>) : null}
    </View>
  );
}

function Stop(props: {
  stop: GuideStop; index: number; count: number; nextTitle: string | null; guide: PullRequestGuideModel; width: () => number; railOpen: () => boolean; onToggleRail: () => void; rail: () => ReturnType<typeof View>;
  commenting: ExcerptCommenting | null; onStep: (delta: 1 | -1) => void; onAsk: ((question: string) => void) | null; onFinish: (() => void) | null; onOpenFile: (path: string) => void;
}) {
  const stop = props.stop;
  effect(() => { void props.guide.loadExcerptDiff([...stop.excerpts, ...stop.files]); });
  const lettered = letterStopNotes(stop);
  const excerptPaths = new Set(stop.excerpts.map((excerpt) => excerpt.path));
  const otherFiles = stop.files.filter((file) => !excerptPaths.has(file.path));
  const aside = () => lettered.lettered.length > 0 && props.width() >= GUIDE_NOTES_ASIDE_MIN_WIDTH;
  const narrow = () => props.width() < GUIDE_RAIL_MIN_WIDTH;
  const arrow = (label: string, icon: string, disabled: boolean, delta: 1 | -1) => (
    <View role="button" accessibilityLabel={label} accessibilityState={{ disabled }} onPress={() => { if (!disabled) props.onStep(delta); }} class={`size-6 items-center justify-center rounded-md border border-border ${disabled ? "opacity-50" : "hover:bg-accent-50"}`}><PRIcon name={icon} size={12} /></View>
  );
  return (
    <View class="flex-row gap-8">
      <View class="min-w-0 flex-1 flex-col gap-5">
        <View class="flex-col">
          <View class="flex-row items-center justify-between gap-2">
            {narrow() ? (
              <View role="button" accessibilityLabel={`Stop ${props.index + 1} of ${props.count}`} accessibilityState={{ expanded: props.railOpen() }} onPress={props.onToggleRail} class="h-6 flex-row items-center gap-1 rounded-md px-2 hover:bg-accent-50">
                <Text class="text-xs text-muted-foreground tabular-nums">{`Stop ${props.index + 1} of ${props.count}`}</Text>
                <ChevronTurn open={props.railOpen} degrees={180}><PRIcon name="chevron-down" size={14} /></ChevronTurn>
              </View>
            ) : <Text class="text-xs text-muted-foreground tabular-nums">{`Stop ${props.index + 1} of ${props.count}`}</Text>}
            <View class="flex-row items-center gap-1">{arrow("Previous stop", "chevron-up", props.index === 0, -1)}{arrow("Next stop", "chevron-down", props.index === props.count - 1, 1)}</View>
          </View>
          {narrow() && props.railOpen() ? <View class="pt-3">{props.rail()}</View> : null}
        </View>
        <View class="flex-col gap-2">
          <Text class="text-lg font-semibold text-foreground">{stop.title}</Text>
          {stop.summary.trim() ? <PullRequestMarkdown class="text-sm" text={stop.summary} /> : null}
        </View>
        {stop.attention ? (
          <View class="flex-row items-start gap-2 rounded-lg border border-border bg-muted-30 px-3 py-2">
            <PRIcon name="eye" size={14} />
            <View class="min-w-0 flex-1 flex-col gap-1">
              <Text class="text-xs font-medium text-foreground">{GUIDE_ATTENTION_LABEL[stop.attention.kind] ?? "Worth a look"}</Text>
              <PullRequestMarkdown class="text-sm" text={stop.attention.note} />
            </View>
          </View>
        ) : null}
        {stop.excerpts.length > 0 ? (
          <View class="flex-col gap-4">
            <Each of={stop.excerpts} key={(excerpt: GuideStop["excerpts"][number], at: number) => `${at}:${excerpt.path}:${excerpt.side}:${excerpt.start}-${excerpt.end}`}>
              {(item, at) => <GuideExcerpt excerpt={item()} patch={() => props.guide.patch()} loading={() => props.guide.diffLoading()} error={() => props.guide.diffError()} notes={lettered.byExcerpt[at()] ?? []} commenting={props.commenting} onOpenFile={props.onOpenFile} loadContents={props.guide.diffFileContents} />}
            </Each>
          </View>
        ) : null}
        {!aside() ? <GuideNotes notes={lettered.lettered} /> : null}
        {otherFiles.length > 0 ? (
          <View class="flex-col gap-1.5">
            <Text class="text-xs font-medium text-muted-foreground">{stop.excerpts.length > 0 ? "Also in this stop" : "Files in this stop"}</Text>
            <View class="flex-col overflow-hidden rounded-lg border border-border-60">
              <Each of={otherFiles} key={(file: GuideStop["files"][number]) => file.path}>{(file) => <OtherFile file={file()} guide={props.guide} />}</Each>
            </View>
          </View>
        ) : null}
        {stop.questions.length > 0 || props.onAsk !== null ? (
          <View class="flex-col gap-1.5">
            {stop.questions.length > 0 ? <Text class="text-xs font-medium text-muted-foreground">Questions to consider</Text> : null}
            <View class="flex-col items-start gap-1.5">
              <Each of={stop.questions} key={(question: string) => question}>
                {(question) => props.onAsk === null ? <Text class="text-sm text-foreground">{question()}</Text> : (
                  <View role="button" accessibilityLabel={`Ask an agent: ${question()}`} onPress={() => props.onAsk!(question())} class="flex-row items-start gap-2 rounded-lg border border-border-60 px-3 py-1.5 hover:bg-accent-50">
                    <PRIcon name="message-circle-question" size={14} /><Text class="min-w-0 shrink text-sm text-foreground">{question()}</Text>
                  </View>
                )}
              </Each>
              {props.onAsk !== null ? (
                <View role="button" accessibilityLabel="Ask about this stop" onPress={() => props.onAsk!("")} class="h-7 flex-row items-center gap-1.5 rounded-md px-2.5 hover:bg-accent-50"><PRIcon name="message-circle-question" size={14} /><Text class="text-sm text-muted-foreground">Ask about this stop</Text></View>
              ) : null}
            </View>
          </View>
        ) : null}
        <View class="flex-row flex-wrap items-center justify-end gap-3 border-t border-border-60 pt-4">
          {props.nextTitle !== null ? (
            <View role="button" accessibilityLabel={`Next: ${props.nextTitle}`} onPress={() => props.onStep(1)} class="min-h-8 max-w-full flex-row items-center gap-1.5 rounded-md bg-primary px-3 py-1"><Text class="min-w-0 shrink text-sm font-medium text-primary-foreground">{`Next: ${props.nextTitle}`}</Text><PRIcon name="arrow-left" size={14} /></View>
          ) : props.onFinish !== null ? (
            <View role="button" accessibilityLabel="Finish review" onPress={props.onFinish} class="h-8 flex-row items-center gap-1.5 rounded-md bg-primary px-3"><PRIcon name="message-square" size={14} /><Text class="text-sm font-medium text-primary-foreground">Finish review</Text></View>
          ) : null}
        </View>
      </View>
      {aside() ? <View class="w-80 shrink-0"><GuideNotes notes={lettered.lettered} /></View> : null}
    </View>
  );
}

export function PullRequestGuideTab(props: {
  guide: PullRequestGuideModel;
  detail: () => PullRequestDetailData;
  actions: PullRequestActionsModel;
  ref: () => PullRequestRefInput | null;
  onAskAboutLines?: (selection: SelectionExcerpt, request: string) => void;
  onAskAboutStop?: (stop: GuideStop, index: number, question: string) => void;
  onFinishReview?: () => void;
  onOpenFile: (path: string) => void;
}) {
  const guide = props.guide;
  guide.ensureLoaded();
  const width = signal(0);
  const railOpen = signal(false);
  let scroller: ScrollRef | null = null;
  const data = () => guide.result();
  const running = () => guide.writing() || (data() !== null && guideRunning(data()!));
  const failure = () => (data() ? guideFailure(data()!) : null);
  const stops = () => data()?.guide?.stops ?? [];
  const position = () => Math.max(0, Math.min(guide.position(), stops().length - 1));
  const writeLabel = (label: string) => (running() ? "Reading the change..." : label);
  const goTo = (next: number) => { guide.goTo(next); railOpen.set(false); scroller?.scrollTo({ y: 0, animated: false }); };
  const step = (delta: 1 | -1) => goTo(guideStepIndex(position(), delta, stops().length));
  // GuideTour: J steps forward and K back while the guide is shown, not while typing or with the command palette open.
  effect(() => {
    if (stops().length === 0) return;
    const press = (delta: 1 | -1) => () => { if (!untracked(paletteOpen)) step(delta); };
    return keymap.bind({ j: press(1), k: press(-1) }, { when: "notEditing" });
  });
  const commenting = (): ExcerptCommenting | null => (props.detail().capabilities.inlineComment === true || props.onAskAboutLines ? { detail: props.detail, ref: props.ref, actions: props.actions, onAskAgent: props.onAskAboutLines ?? null } : null);
  const rail = () => <GuideRail stops={stops()} position={position()} seen={guide.seen()} onSelect={goTo} showCount={width() >= GUIDE_RAIL_MIN_WIDTH} />;
  const details = signal(false);
  const technical = () => (failure() === null || running() ? null : (
    <View class="flex-col items-center gap-2">
      <View role="button" accessibilityLabel="Technical details" accessibilityState={{ expanded: details() }} onPress={() => details.set(!details())}><Text class="text-xs text-muted-foreground">Technical details</Text></View>
      {details() ? <View class="w-full max-w-lg rounded-lg border border-border bg-muted-40 p-3"><Text class="font-mono text-xs text-muted-foreground">{failure()}</Text></View> : null}
    </View>
  ));
  return (
    <View class="min-h-0 flex-1 flex-col" accessibilityLabel="Pull request guide" onLayout={(event) => width.set(event.bounds.size.width)}>
      {guide.status() === "loading" && !data() ? <View class="min-h-48 items-center justify-center"><Text class="text-sm text-muted-foreground">Loading review guide...</Text></View> : null}
      {data() && data()!.guide === null ? (
        <Scroll class="min-h-0 flex-1" contentClass="items-center justify-center gap-2 px-4 py-10">
          <Text class="text-sm font-medium text-foreground">{running() ? "Writing a review guide" : failure() === null ? "No review guide yet" : "Could not write a review guide"}</Text>
          <Text class="max-w-md text-center text-xs text-muted-foreground">
            {running() ? "An agent is reading the change. A large one takes a few minutes. You can leave; you will be told when it is ready." : failure() === null ? (guide.error() || "A guide is a tour of the change: stops through the code in reading order, with the calls only a maintainer can make.") : GUIDE_FAILURE_HINT}
          </Text>
          <OutlineButton label={writeLabel(failure() === null ? "Write guide" : "Try again")} icon="sparkles" disabled={running()} onPress={() => void guide.write()} />
          {technical()}
        </Scroll>
      ) : null}
      {guide.status() === "error" && !data() ? <View class="px-4 py-6"><Text class="text-sm text-destructive">{guide.error()}</Text></View> : null}
      {data() && data()!.guide !== null ? (
        <View class="min-h-0 flex-1 flex-row gap-6 px-4 py-4">
          {width() >= GUIDE_RAIL_MIN_WIDTH ? <Scroll class="w-64 shrink-0">{rail()}</Scroll> : null}
          <Scroll class="min-h-0 min-w-0 flex-1" ref={(node: ScrollRef) => { scroller = node; }} contentClass="gap-4">
            {guideIsStale(data()!) || failure() !== null || running() ? (
              <View class="flex-row items-center gap-2 rounded-lg border border-border bg-warning-surface px-3 py-2">
                {running() ? <Text class="text-xs text-muted-foreground">…</Text> : <PRIcon name="triangle-alert" size={14} />}
                <Text class="min-w-0 flex-1 text-xs text-foreground">{running() ? "Rewriting this guide. You will be told when the new one is ready." : failure() === null ? "Written before the latest push." : `Could not rewrite this guide. ${GUIDE_FAILURE_HINT}`}</Text>
                {!running() ? <OutlineButton label="Rewrite" icon="sparkles" onPress={() => void guide.write()} /> : null}
              </View>
            ) : null}
            {!running() && failure() !== null ? technical() : null}
            {guide.diffError() ? <Text class="text-xs text-muted-foreground">{`The diff could not be loaded, so excerpts are missing: ${guide.diffError()}`}</Text> : null}
            {stops().length === 0 ? <Text class="text-sm text-muted-foreground">This change has no files to tour.</Text> : (
              <Each of={[position()]} key={(at: number) => String(at)}>
                {(at) => (
                  <Stop
                    stop={stops()[at()]!} index={at()} count={stops().length} nextTitle={stops()[at() + 1]?.title ?? null} guide={guide} width={() => width()}
                    railOpen={() => railOpen()} onToggleRail={() => railOpen.set(!railOpen())} rail={rail} commenting={commenting()} onStep={step}
                    onAsk={props.onAskAboutStop ? (question) => props.onAskAboutStop!(stops()[at()]!, at(), question) : null}
                    onFinish={props.onFinishReview ? () => { guide.markRead(at()); props.onFinishReview!(); } : null}
                    onOpenFile={props.onOpenFile}
                  />
                )}
              </Each>
            )}
          </Scroll>
        </View>
      ) : null}
    </View>
  );
}
