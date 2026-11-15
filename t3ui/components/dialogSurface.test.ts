// The modal look: the scrim is the page colour at the web's alpha plus a blur, and the card is the page colour
// (the web's dialog-glass over its blurred backdrop), not the lighter popover slate that menus use.
import { expect, test } from "nsh/test";
import theme from "../theme.json";
import { DIALOG_BACKDROP_BLUR, DIALOG_CARD_CLASS, dialogBackdropAlpha, dialogBackdropStyle } from "./dialogSurface";
import { parseColor } from "./composer/tokenColor";

test("the dialog card paints the background token, not the popover token", () => {
  expect(DIALOG_CARD_CLASS).toContain("bg-background");
  expect(DIALOG_CARD_CLASS).not.toContain("popover");
  // Ocean dark: the background is #17212b (the reference palette measured about that); the popover is the lighter #414851 the port wrongly used.
  const dark = (theme as { cssVars: { dark: Record<string, string> } }).cssVars.dark;
  expect(parseColor(dark.background!)).toEqual([23, 33, 43]);
  expect(parseColor(dark.popover!)).toEqual([65, 72, 81]);
});

test("the scrim is translucent and blurred like dialog-backdrop", () => {
  const alpha = dialogBackdropAlpha();
  expect(alpha === 0.64 || alpha === 0.6).toBe(true);
  const style = dialogBackdropStyle();
  expect(style.backdropFilter).toBe(`blur(${DIALOG_BACKDROP_BLUR}px)`);
  expect(DIALOG_BACKDROP_BLUR).toBe(4);
  expect(typeof style.backgroundColor).toBe("string");
  expect(style.backgroundColor).not.toContain("0, 0, 0");
});

test("fm13: nested dialogs: the count of dialogs opened above, and the stacked look per level", async () => {
  const { nestedDialogCount, nestedDialogStyle } = await import("./dialogSurface");
  expect(nestedDialogCount(1, [1, 2, 3])).toBe(2);
  expect(nestedDialogCount(3, [1, 2, 3])).toBe(0);
  expect(nestedDialogCount(9, [1, 2])).toBe(0);
  expect(nestedDialogStyle(0)).toEqual({ scale: 1, translateY: 0, opacity: 1 });
  expect(nestedDialogStyle(1)).toEqual({ scale: 0.9, translateY: -20, opacity: 0.9 });
});
