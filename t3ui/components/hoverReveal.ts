// hoverReveal.ts: the workaround for `group`/`group-hover:`/`group-focus-within:` on a plain app
// View, confirmed not to work on this runtime's GPUI host (see workspace/nsh-runtime-bugs.md). A
// headless `nsh test` run of the same classes DOES recolor the descendant, so a headless test can
// never catch a regression of this bug: it only proves the signal wiring below, not the Tailwind
// ancestor combinator. SidebarThreadRow.tsx and MessageRow.tsx hand-roll this same shape; new
// group-hover/group-focus-within sites should use `createHover()` instead of hand-rolling it again.
import { signal } from "nsh";

export interface HoverReveal {
  /** True while the pointer is over the bound element (`bind`) or a tracked descendant has focus
   * (`trackFocus`): the `group-hover:`/`group-focus-within:` replacement condition. */
  hovered: () => boolean;
  /** Spread onto the element that stands in for the Tailwind `group` ancestor. */
  bind: { onMouseEnter: () => void; onMouseLeave: () => void };
  /** Spread onto each focusable descendant that stands in for `group-focus-within:`: a button, a
   * link, an input. Focus does not bubble to an ancestor's own `onFocus`/`onBlur` in this runtime,
   * so every such descendant must carry this itself, same as SidebarThreadRow's RowButton. */
  trackFocus: { onFocus: () => void; onBlur: () => void };
}

export function createHover(): HoverReveal {
  const pointerOver = signal(false);
  const focusedWithin = signal(false);
  return {
    hovered: () => pointerOver() || focusedWithin(),
    bind: {
      onMouseEnter: () => pointerOver.set(true),
      onMouseLeave: () => pointerOver.set(false),
    },
    trackFocus: {
      onFocus: () => focusedWithin.set(true),
      onBlur: () => focusedWithin.set(false),
    },
  };
}
