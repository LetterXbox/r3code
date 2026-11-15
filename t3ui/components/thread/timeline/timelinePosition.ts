// useTimelinePositionRestore.ts and timelineScrollAnchoring.ts: a thread left while the reader was up in its history opens where it was
// left (the row at the top of the view, else the offset); one left at its end opens at its end.
import type { TimelineEntry } from "../timeline";

/** Only this client's optimistic send requests the new-turn anchor. */
export function shouldAnchorNewUserMessage(entry: TimelineEntry | undefined): boolean {
  return entry?.kind === "message" && entry.message.role === "user" && entry.message.pending === true;
}

export type RememberedPosition = {
  /** The first row in view when the thread was left. */
  rowId: string | null;
  /** The reader was following the end. */
  atEnd: boolean;
  /** The content offset, for when the row is gone. */
  scrollOffset: number;
  /** timelineScrollAnchoring RememberedTimelinePosition.offsetWithinRow: how far the view's top was into that row. */
  offsetWithinRow?: number;
};

export type RestoreTarget = { kind: "end" } | { kind: "row"; index: number; rowId: string; offsetWithinRow: number } | { kind: "offset"; offset: number };

/** At most this many threads' positions are kept, the least recently left dropped first. */
export const REMEMBERED_POSITIONS = 64;

export function createPositionMemory(limit = REMEMBERED_POSITIONS) {
  const positions = new Map<string, RememberedPosition>();
  return {
    remember(key: string, position: RememberedPosition) {
      positions.delete(key);
      positions.set(key, position);
      while (positions.size > limit) {
        const oldest = positions.keys().next().value;
        if (oldest === undefined) break;
        positions.delete(oldest);
      }
    },
    recall(key: string): RememberedPosition | undefined {
      return positions.get(key);
    },
    forget(key: string) {
      positions.delete(key);
    },
  };
}

/** Where a thread opens: its end unless the reader left it in its history, then that row, else that offset. */
export function restoreTarget(position: RememberedPosition | undefined, rowIds: readonly string[]): RestoreTarget {
  if (!position || position.atEnd) return { kind: "end" };
  const index = position.rowId === null ? -1 : rowIds.indexOf(position.rowId);
  if (index >= 0) return { kind: "row", index, rowId: position.rowId!, offsetWithinRow: Math.max(0, position.offsetWithinRow ?? 0) };
  return { kind: "offset", offset: Math.max(0, position.scrollOffset) };
}

/** The first row in view from a viewability report: the lowest index among the viewable items. */
export function firstViewableId(viewable: ReadonlyArray<{ key: string; index: number; isViewable: boolean }>): string | null {
  let first: { key: string; index: number } | null = null;
  for (const token of viewable) if (token.isViewable && (first === null || token.index < first.index)) first = token;
  return first ? first.key : null;
}

/** The timeline's shared memory of where each thread was left. */
export const timelinePositions = createPositionMemory();

/** useTimelinePositionRestore SETTLE_MAX_FRAMES: a streaming reply moves the end every frame; past this the list's own end upkeep takes over. */
export const SETTLE_MAX_FRAMES = 60;

/**
 * useTimelinePositionRestore settleListScroll: index and end scrolls start from estimated row sizes and can stop short of a
 * tall row. Corrects against the measured layout until the view holds the target for two frames, the frame budget runs
 * out, the caller cancels, or the target disappears (`target` resolves undefined).
 */
export function settleListScroll(io: {
  requestFrame: (callback: () => void) => void;
  scrollOffset: () => number;
  target: () => Promise<number | undefined> | number | undefined;
  scrollToOffset: (offset: number) => void;
  isCancelled: () => boolean;
}): Promise<void> {
  return new Promise((resolve) => {
    let stableFrames = 0;
    let frames = 0;
    const reconcile = async () => {
      if (io.isCancelled()) return resolve();
      const offset = await io.target();
      frames += 1;
      if (io.isCancelled() || offset === undefined || frames > SETTLE_MAX_FRAMES) return resolve();
      if (Math.abs(io.scrollOffset() - offset) > 1) {
        stableFrames = 0;
        io.scrollToOffset(offset);
        io.requestFrame(() => void reconcile());
        return;
      }
      stableFrames += 1;
      if (stableFrames >= 2) resolve();
      else io.requestFrame(() => void reconcile());
    };
    io.requestFrame(() => void reconcile());
  });
}

/** The restore target of a saved row: its measured top in the view plus how far into it the reader was, kept inside the content. */
export function rowRestoreOffset(input: { scrollOffset: number; rowTopInView: number; offsetWithinRow: number; maxOffset: number }): number {
  return Math.max(0, Math.min(input.scrollOffset + input.rowTopInView + input.offsetWithinRow, Math.max(0, input.maxOffset)));
}

/** timelineScrollAnchoring CHAT_TIMELINE_ANCHOR_OFFSET: a newly sent message pins this far below the top of the view. */
export const CHAT_TIMELINE_ANCHOR_OFFSET = 24;

/**
 * The anchored end space (resolveChatListAnchoredEndSpace, LegendList anchoredEndSpace): room after the last row so the
 * anchored message can scroll to `anchorOffset` below the top even while the rows after it are shorter than the view.
 * `contentHeight` excludes the space itself.
 */
export function anchoredEndSpace(input: { anchorTopInContent: number; contentHeight: number; viewportHeight: number; anchorOffset?: number }): number {
  const offset = input.anchorOffset ?? CHAT_TIMELINE_ANCHOR_OFFSET;
  return Math.max(0, Math.round(input.anchorTopInContent - offset + input.viewportHeight - input.contentHeight));
}

/** shouldReleaseTimelineAnchorForToolActivity: tool activity (a work, live, subagent or folded-work row) after the anchored message releases it. */
export function anchorReleasedByToolActivity(rows: ReadonlyArray<{ id: string; kind: string }>, anchorRowId: string | null): boolean {
  if (anchorRowId === null) return false;
  const at = rows.findIndex((row) => row.id === anchorRowId);
  if (at < 0) return false;
  for (let index = at + 1; index < rows.length; index += 1) {
    const kind = rows[index].kind;
    if (kind === "work" || kind === "live" || kind === "subagents" || kind === "fold") return true;
  }
  return false;
}
