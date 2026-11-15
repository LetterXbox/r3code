// The composer context strip's compact mode (BranchToolbar.tsx useLabelsOverflow, BranchToolbar.logic.ts
// resolveContextStripLabelsCompact, ComposerContextLabel.tsx): when the strip's labels (Current checkout, a branch, the
// environment, the permissions mode) need more room than the strip has, every label collapses to nothing and the controls
// show only their icons; they come back once there is 16pt to spare (hysteresis, so the width boundary does not flap).
//
// The reference sums the strip's children and adds how much wider each label wants to be than it is. Here the strip has a
// spacer that takes whatever width is left, so the labels fit exactly while their growth is no more than that spacer plus the
// one gap it replaces: `needed > available` is `growth > spacer + gap`, with `-16` more on the way back.
import { effect, signal, untracked } from "nsh";

/** BranchToolbar.logic.ts CONTEXT_STRIP_COMPACT_EXPAND_HYSTERESIS_PX. */
export const CONTEXT_STRIP_EXPAND_HYSTERESIS = 16;
/** The strip's `gap-2` between its groups. */
export const CONTEXT_STRIP_GAP = 8;
/** ComposerContextLabel.tsx `max-w-[240px]`. */
export const CONTEXT_LABEL_MAX_WIDTH = 240;

/** resolveContextStripLabelsCompact. */
export function resolveContextStripLabelsCompact(input: { compact: boolean; neededWidth: number; availableWidth: number }): boolean {
  return input.compact ? input.neededWidth > input.availableWidth - CONTEXT_STRIP_EXPAND_HYSTERESIS : input.neededWidth > input.availableWidth;
}

/** The compact decision from the spacer's width and what the labels want. `labels`: width each takes now, and the width it wants. */
export function contextStripCompactFor(input: { compact: boolean; spacerWidth: number; labels: ReadonlyArray<{ current: number; natural: number }> }): boolean {
  const growth = input.labels.reduce((sum, label) => sum + Math.max(0, label.natural - label.current), 0);
  const available = 0;
  // needed - available = growth - (spacer + gap): the labels' extra width less the room the spacer has.
  return resolveContextStripLabelsCompact({ compact: input.compact, neededWidth: growth - (input.spacerWidth + CONTEXT_STRIP_GAP), availableWidth: available });
}

interface LabelEntry { current: number; natural: number }

const compact = signal(false);
const spacer = signal<number | null>(null);
const labels = signal<ReadonlyMap<number, LabelEntry>>(new Map());
let nextId = 0;

/** True while the strip's labels are collapsed to their icons. */
export const contextStripCompactMode = () => compact();

/** The strip reports the width of its spacer (the room left once every control has its label). */
export function reportContextStripSpacer(width: number): void {
  spacer.set(width);
}

/** A label registers its width now and the width it wants; returns what to call as they change and on unmount. */
export function registerContextLabel() {
  const id = nextId++;
  const update = (patch: Partial<LabelEntry>) => untracked(() => {
    const next = new Map(labels());
    next.set(id, { ...(next.get(id) ?? { current: 0, natural: 0 }), ...patch });
    labels.set(next);
  });
  const remove = () => untracked(() => {
    const next = new Map(labels());
    next.delete(id);
    labels.set(next);
  });
  return { setCurrent: (width: number) => update({ current: width }), setNatural: (width: number) => update({ natural: width }), remove };
}

/** Called once by the strip: derives the compact state from the spacer and the labels, and says when it is about to flip. */
export function watchContextStrip(onFlip: (next: boolean) => void): void {
  effect(() => {
    const room = spacer();
    const entries = [...labels().values()];
    if (room === null || entries.length === 0) return;
    untracked(() => {
      const next = contextStripCompactFor({ compact: compact(), spacerWidth: room, labels: entries });
      if (next === compact()) return;
      onFlip(next);
      compact.set(next);
    });
  });
}

/** Forgets everything (a strip that unmounts, tests). */
export function resetContextStrip(): void {
  compact.set(false);
  spacer.set(null);
  labels.set(new Map());
}

/** What the strip knows now (tests, diagnostics). */
export function contextStripSnapshot() {
  return { compact: compact(), spacer: spacer(), labels: [...labels().values()] };
}
