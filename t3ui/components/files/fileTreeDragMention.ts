// fileTreeDragMention.ts + composerMentionDrag.ts: dragging Files rows onto the composer inserts their mentions.
// NSH has no in-app drag data transfer (only local file drops), so the drag is the row's own pan gesture: it starts
// at the row's press point, and the release point (start + translation) is hit-tested against the composer, which
// registers itself as the one drop target. A drag of a selected row carries the whole selection, as the reference's.
import { signal } from "nsh";
import type { ViewRef } from "nsh";
import { serializeComposerFileLink } from "../composer/editor/promptDocument";
import { composerDraft, openThread, setComposerDraft } from "../../store";
import { attachExtraContext, attachPullRequest, extraContextMarker, inlineContextIds, pullRequestContextRecord, pullRequestMarker, rememberMention, threadContextRecord } from "../composer/contextChips";
import { placeContextReference } from "../composer/terminalContext";
type PullRequestRef = Parameters<typeof attachPullRequest>[1];
import { showToast } from "../toast";
import { droppedThreadNeedsTranscript, importDroppedThreadTranscript } from "../composer/threadTranscriptImport";
import { draftWithMention } from "./fileActions";

/** composerMentionFromTreePath: a tree path's mention, or null for the root. */
export function composerMentionFromTreePath(treePath: string): string | null {
  const relativePath = treePath.replace(/\/+$/, "");
  return relativePath.length === 0 ? null : serializeComposerFileLink(relativePath);
}

/** The mentions a drag of `itemPath` carries: the selection when the row is in it, else that row. */
export function draggedMentions(itemPath: string, selection: readonly string[], mentionPath?: (treePath: string) => string): { paths: string[]; text: string } | null {
  const paths = selection.includes(itemPath) ? [...selection] : [itemPath];
  const mentions = paths
    .map((path) => {
      const treePath = path.replace(/\/+$/, "");
      return composerMentionFromTreePath(treePath && mentionPath ? mentionPath(treePath) : path);
    })
    .filter((mention): mention is string => mention !== null);
  return mentions.length === 0 ? null : { paths, text: mentions.join(" ") };
}

type Rect = { x: number; y: number; width: number; height: number };
interface DropTarget { node: ViewRef; setActive: (active: boolean) => void; insert: (text: string) => boolean; onRejected: () => void }

let target: DropTarget | null = null;
let lastRect: Rect | null = null;
/** The drag in progress: its mention text and where it started (page coordinates). */
const active = signal<{ text: string; start: { x: number; y: number } } | null>(null);
export const mentionDragInProgress = () => active() !== null;

/** The composer's hook: its outer view, how it shows a claimed drag, and how it inserts the dropped text. */
export function registerMentionDropTarget(node: ViewRef | null, host: Omit<DropTarget, "node">) {
  if (!node) { if (target) target = null; return; }
  target = { node, ...host };
}

async function measureTarget(): Promise<Rect | null> {
  const current = target;
  if (!current) return null;
  try {
    const at = await current.node.measure();
    if (!at) return null;
    lastRect = { x: at.pagePosition.x, y: at.pagePosition.y, width: at.bounds.size.width, height: at.bounds.size.height };
    return lastRect;
  } catch {
    return lastRect;
  }
}

const inside = (rect: Rect | null, point: { x: number; y: number }) => rect !== null && point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;

export function beginMentionDrag(text: string, start: { x: number; y: number }) {
  active.set({ text, start });
  void measureTarget();
}

/** The pointer moved during a drag (page coordinates): the composer shows it is claimed while the pointer is over it. */
export function moveMentionDrag(point: { x: number; y: number }) {
  if (!active()) return;
  target?.setActive(inside(lastRect, point));
}

/** The drag ended `translation` from its start: a release over the composer inserts the mentions (with a trailing space). */
export async function endMentionDrag(translation: { x: number; y: number }, cancelled: boolean): Promise<boolean> {
  const drag = active();
  active.set(null);
  const current = target;
  current?.setActive(false);
  if (!drag || cancelled || !current) return false;
  const rect = await measureTarget();
  const point = { x: drag.start.x + translation.x, y: drag.start.y + translation.y };
  if (!inside(rect, point)) return false;
  if (!current.insert(`${drag.text} `)) current.onRejected();
  return true;
}

/** The composer's insert: the mentions go at the end of the open thread's draft (insertTextAtEnd with a leading
 * boundary), each remembered as a file mention so the chip renders. False when no chat is open. */
export function insertDroppedMentions(text: string): boolean {
  const thread = openThread();
  if (!thread) return false;
  setComposerDraft(draftWithMention(composerDraft(), text.trimEnd()));
  for (const mention of text.match(/\[(?:\\.|[^\]\\])*\]\([^)\s]*\)/gu) ?? []) rememberMention(thread.id, mention, "file");
  return true;
}

// threadContextDrag.ts: dragging a thread from the sidebar onto the composer attaches it as a thread context. The
// sidebar's own pan (sidebarDrag.tsx) owns the gesture; it asks here whether the pointer is over the composer.
/** Measure the composer once as a thread drag begins. */
export function primeThreadDrop() { void measureTarget(); }

/** The thread drag moved: the composer shows it is claimed while the pointer is over it (data-thread-context-over). */
export function moveThreadDrag(point: { x: number; y: number }): boolean {
  const over = inside(lastRect, point);
  target?.setActive(over);
  return over;
}

/** Whether `point` is over the composer, without any side effect. */
export const pointOverComposer = (point: { x: number; y: number }) => inside(lastRect, point);

/** The thread drag ended: when released over the composer, the thread joins the open thread's context (the marker goes at
 * the end of the prompt) and true is returned so the sidebar does not also treat the drop as a section change. */
export function dropThreadOnComposer(point: { x: number; y: number }, thread: { id: string; title: string }, environmentId: string | undefined): boolean {
  target?.setActive(false);
  if (!inside(lastRect, point)) return false;
  const open = openThread();
  if (!open || !environmentId || thread.id === open.id) { if (target) target.onRejected(); return true; }
  // useThreadContextDrop: a machine the open thread's agent cannot read comes in as the thread's transcript file.
  if (droppedThreadNeedsTranscript(thread.id)) { void importDroppedThreadTranscript(thread.id); return true; }
  const record = threadContextRecord({ environmentId, threadId: thread.id }, thread.title);
  attachExtraContext(open.id, record);
  inlineContextIds.add(record.contextId);
  placeContextReference(extraContextMarker(record));
  return true;
}

// composerMentionDrag.ts COMPOSER_PULL_REQUEST_DRAG_TYPE: a linked pull request row dragged onto the composer attaches it as a
// pull request context (the same record and marker the `#` menu makes). The row's own pan gesture carries it, as the Files rows do.
export function dropPullRequestOnComposer(point: { x: number; y: number }, pullRequest: PullRequestRef): boolean {
  target?.setActive(false);
  if (!inside(lastRect, point)) return false;
  const open = openThread();
  if (!open) { target?.onRejected(); return true; }
  attachPullRequest(open.id, pullRequest);
  const record = pullRequestContextRecord(pullRequest);
  inlineContextIds.add(record.contextId);
  placeContextReference(pullRequestMarker(record));
  return true;
}

/** Spread on a pull request row; `pullRequest` is null while the host has not reported the pull request (the web drags only then-known ones). */
export function pullRequestDragHandlers(pullRequest: () => PullRequestRef | null) {
  let last = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  return {
    onMouseMove: (event: { pagePosition: { x: number; y: number } }) => { last = { x: event.pagePosition.x, y: event.pagePosition.y }; },
    onPanStart: () => { if (!pullRequest()) return; start = last; primeThreadDrop(); },
    onPanEnd: (event: { translation: { x: number; y: number }; cancelled: boolean }) => {
      const dragged = pullRequest();
      if (!dragged || event.cancelled) { target?.setActive(false); return; }
      dropPullRequestOnComposer({ x: start.x + event.translation.x, y: start.y + event.translation.y }, dragged);
    },
  };
}

/** ChatComposer's onInsertRejected. */
export function rejectDroppedMentions() {
  showToast({ type: "error", title: "Unable to add to chat", description: "The composer is busy; try again once it is ready." });
}

/** Everything the composer passes: `ref={(node) => registerComposerMentionDrop(node, dragOver.set)}`. */
export function registerComposerMentionDrop(node: ViewRef | null, setActive: (active: boolean) => void) {
  registerMentionDropTarget(node, { setActive, insert: insertDroppedMentions, onRejected: rejectDroppedMentions });
}
