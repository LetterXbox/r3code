// SidebarProviderUpdatePill.tsx:94-132: the pill shows `renderedView`; when the view goes away or its key changes, the
// rendered one plays its 180ms exit first and only then does the next one (or nothing) take its place.
import { cleanup, effect, signal, untracked } from "nsh";

/** What to do when the live view changes under a pill that shows `shownKey`. */
export function pillStep(shownKey: string | null, nextKey: string | null): "show" | "update" | "exit" {
  if (shownKey === null) return "show";
  if (nextKey === shownKey) return "update";
  return "exit";
}

export function createPillSwap<T extends { key: string }>(source: () => T | null, ms: number) {
  const shown = signal<T | null>(untracked(source));
  const leaving = signal(false);
  let pending: T | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const next = source();
    untracked(() => {
      if (leaving()) { pending = next; return; }
      const step = pillStep(shown()?.key ?? null, next?.key ?? null);
      if (step === "exit" && ms <= 0) { shown.set(next); return; }
      if (step === "show" || step === "update") { shown.set(next); return; }
      pending = next;
      leaving.set(true);
      timer = setTimeout(() => {
        timer = undefined;
        leaving.set(false);
        shown.set(pending);
      }, ms);
    });
  });
  cleanup(() => { if (timer !== undefined) clearTimeout(timer); });
  return { shown: () => shown(), leaving: () => leaving() };
}
