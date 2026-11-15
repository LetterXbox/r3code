// Shared size metrics for nsh/base primitives that have no built-in sizing of their own
// (Button, Switch, Kbd-like chips, Badge-like chips, Tooltip popups), matching the reference's
// apps/web/src/components/ui/*.tsx desktop (`sm:`) values. This app has no responsive breakpoint
// (it always renders at the reference's desktop width), so every constant below is the reference's
// `sm:` value, not its unprefixed mobile/touch one.
//
// Like menus (see menuStyles.ts), nsh/base ships none of these with default classes
// ("no colors, sizes... of its own" — base.d.ts), so every call site sets its own. These constants
// exist so repeated call sites share one right answer instead of repeating (or drifting from) it.

// --- Switch (ui/switch.tsx): --thumb-size default sm:spacing(4)=16px, sm size sm:spacing(3.5)=14px.
// track height = thumb-size+2, width = thumb-size*2-2; thumb visual = thumb-size-2; checked translate = thumb-size-4.
export const SWITCH_TRACK_DEFAULT_CLASS = "h-[18px] w-[30px] justify-center rounded-full p-[2px] bg-input checked:bg-primary transition-colors duration-200 ease-in-out";
export const SWITCH_THUMB_DEFAULT_CLASS = "size-3.5 rounded-full bg-background checked:translate-x-3 transition-transform duration-150 ease-in-out";
export const SWITCH_TRACK_SM_CLASS = "h-4 w-6.5 justify-center rounded-full bg-input checked:bg-primary transition-colors duration-200 ease-in-out";
export const SWITCH_THUMB_SM_CLASS = "size-3 rounded-full bg-background checked:translate-x-2.5 transition-transform duration-150 ease-in-out";

// --- Button (ui/button.tsx) desktop (`sm:`) heights, text sizes and icon sizes per size variant.
export const BUTTON_SIZE = {
  xs: { box: "h-6", text: "text-xs", icon: 14 },
  sm: { box: "h-7", text: "text-sm", icon: 16 },
  default: { box: "h-8", text: "text-sm", icon: 16 },
  lg: { box: "h-9", text: "text-sm", icon: 16 },
  "icon-xs": { box: "size-6", icon: 14 },
  "icon-sm": { box: "size-7", icon: 16 },
  icon: { box: "size-8", icon: 16 },
} as const;
/** Button radius: `rounded-[var(--control-radius)]` = `--control-radius: 0.5rem` = `rounded-lg`. */
export const BUTTON_RADIUS_CLASS = "rounded-lg";

// --- Kbd chip (ui/kbd.tsx): h-5 min-w-5 px-1 rounded text-xs, icon size-3.
export const KBD_CLASS = "h-5 min-w-5 items-center justify-center rounded px-1 text-xs font-medium";

// --- Badge (ui/badge.tsx) default size, desktop (`sm:`): h-4.5 min-w-4.5 px-[3px] text-xs, rounded-sm.
export const BADGE_CLASS = "h-4.5 min-w-4.5 items-center justify-center rounded-sm px-1 text-xs font-medium";

// --- Tooltip popup (ui/tooltip.tsx): rounded-md, max-w-80 (default variant), text-xs, px-2 py-1 viewport.
export const TOOLTIP_POPUP_CLASS = "max-w-80 rounded-md border border-border bg-popover px-2 py-1";
export const TOOLTIP_TEXT_CLASS = "text-xs";
