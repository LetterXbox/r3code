// Shared row metrics for nsh/base Menu / MenuItem / Submenu, matching the reference's
// apps/web/src/components/ui/menu.tsx desktop (`sm:`) values: MenuPopup, MenuItem,
// MenuSubTrigger, MenuShortcut, MenuGroupLabel, MenuSeparator. The reference leaves colour,
// behaviour and copy to each call site; only the sizes below are shared.
//
// NSH has no component-level default styling for these primitives (confirmed: no central
// menu.tsx-equivalent wrapper existed before this file), so every call site sets its own
// classes. Call sites should import these instead of hand-rolling the same numbers.

/** MenuPopup: `min-w-[min(10rem,calc(100vw-2rem))]` plus the port's glass/border/radius.
 * The reference leaves width otherwise unset so the popup grows to fit its widest row; nsh's
 * Menu treats a bare `min-w` as a cap instead of a floor, so `w-max` is added to force the same
 * grow-to-content sizing (confirmed by right-clicking a thread row: "Auto-settle..." / "Filter by
 * demo-..." were cut off at min-w-40 before this). */
export const MENU_POPUP_CLASS = "min-w-40 w-max rounded-lg border border-border bg-popover-84 p-1";

/** MenuSubPopup (`align="start"`, default `max-w-56`): same surface, narrower cap. */
export const MENU_SUBPOPUP_CLASS = "max-w-56 rounded-lg border border-border bg-popover-84 p-1";

/** MenuItem row: `min-h-8` on touch, `sm:min-h-7 sm:text-sm` on desktop; `rounded-sm px-2 py-1`. */
export const MENU_ITEM_ROW_CLASS = "min-h-7 flex-row items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent";

/** MenuItem icon size (`[&>svg:not([class*='size-'])]:size-4` at `sm:`): 16px. */
export const MENU_ITEM_ICON_SIZE = 16;

/** MenuShortcut: `ms-auto font-medium text-xs tracking-widest` (the reference's `text-secondary-label`
 * colour is left to the caller; this file sets size only). */
export const MENU_SHORTCUT_CLASS = "ms-auto text-xs font-medium tracking-widest";

/** MenuGroupLabel: `px-2 py-1.5 font-medium text-xs`. */
export const MENU_GROUP_LABEL_CLASS = "px-2 py-1.5 text-xs font-medium";

/** MenuSeparator: `mx-2 my-1 h-px`. */
export const MENU_SEPARATOR_CLASS = "mx-2 my-1 h-px bg-border";
