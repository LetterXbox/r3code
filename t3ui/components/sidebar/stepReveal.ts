// index.css:2420 `.sidebar-drag-boundary-label { animation: sidebar-drag-label-reveal 200ms step-end }`: the label and
// rule of a drag boundary hold `visibility: hidden` for the first 200ms of a pickup (so the rows can open their
// clearance first), then show at once. No motion-reduce gate in the reference, so this runs with reduced motion too.
import { cleanup, effect, signal, untracked } from "nsh";

export const DRAG_LABEL_REVEAL_MS = 200;

/** False for `ms` after `active()` turns true, then true; false again once `active()` is false. One run per pickup. */
export function createStepReveal(active: () => boolean, ms = DRAG_LABEL_REVEAL_MS) {
  const revealed = signal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  effect(() => {
    const on = active();
    untracked(() => {
      clear();
      revealed.set(false);
      if (on) timer = setTimeout(() => { timer = undefined; revealed.set(true); }, ms);
    });
  });
  cleanup(clear);
  return () => revealed();
}
