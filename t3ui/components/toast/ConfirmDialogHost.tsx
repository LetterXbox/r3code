// ConfirmDialogHost.tsx: the one confirmation dialog of the app (AlertDialog with Cancel and Confirm). Mounted once in
// App.tsx; modules ask through `confirm(message, { variant })`. A real nsh Dialog, so it draws above every page and
// takes Escape and a backdrop press as Cancel. It registers with the WebView occlusion registry while it is up.
import { cleanup, effect, keymap, Scroll, signal, Text, View, windowSize } from "nsh";
import type { ViewRef } from "nsh";
import { Dialog } from "nsh/base";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { attachConfirmDialogHost, confirmDialogOpen, confirmDialogState, resolveConfirmDialogCopy, respondToConfirmDialog } from "./confirmDialog";
import { dialogBackdropStyle, keepPressInDialog } from "../dialogSurface";
import { EscapeCancel } from "../EscapeCancel";
import { presenceStyle } from "../motion/Motion";
import { dialogScaleEnter, dialogScaleExit, DIALOG_MS } from "../motion/motionTokens";
import { tokenAlpha } from "../composer/tokenColor";

export function ConfirmDialogHost() {
  cleanup(attachConfirmDialogHost());
  useOverlayOpen(() => confirmDialogOpen(), "confirm dialog", DIALOG_MS);
  // Escape cancels, ahead of the page, palette or composer binding under it: a key that fires a binding never reaches the dialog's own close.
  effect(() => {
    if (!confirmDialogOpen()) return;
    return keymap.bind({ escape: () => respondToConfirmDialog(false) }, { when: "always" });
  });
  // AlertDialog (Base UI) moves the focus to the popup's first tabbable control, Cancel; Enter then activates the
  // focused button, as a focused <button> does on the web (Tab reaches Confirm).
  let cancelNode: ViewRef | null = null;
  const focused = signal<"cancel" | "confirm">("cancel");
  effect(() => {
    if (!confirmDialogOpen()) return;
    focused.set("cancel");
    const timer = setTimeout(() => cancelNode?.focus(), 0);
    const unbind = keymap.bind({ enter: () => respondToConfirmDialog(focused() === "confirm") }, { when: "always" });
    return () => { clearTimeout(timer); unbind(); };
  });

  const message = () => { const state = confirmDialogState(); return state.status === "idle" ? "" : state.message; };
  const destructive = () => { const state = confirmDialogState(); return state.status !== "idle" && state.variant === "destructive"; };
  const copy = () => resolveConfirmDialogCopy(message());
  const confirmLabel = () => { const state = confirmDialogState(); return state.status !== "idle" && state.confirmLabel ? state.confirmLabel : "Confirm"; };

  return (
    <Dialog
      open={confirmDialogOpen()}
      animation="fade"
      testID="confirm-dialog"
      onOpenChange={({ open }) => { if (!open) respondToConfirmDialog(false); }}
      backdropStyle={dialogBackdropStyle()}
      style={{ margin: "auto", width: 512, maxWidth: "92%", maxHeight: "92%" }}
    >
      {confirmDialogOpen() ? <EscapeCancel onCancel={() => respondToConfirmDialog(false)} /> : null}
      <View class="overflow-hidden rounded-2xl border border-border bg-background" accessibilityLabel={copy().title} onPress={keepPressInDialog} style={presenceStyle(dialogScaleEnter, dialogScaleExit, confirmDialogOpen)}>
        <View class="gap-2 p-6">
          <Text class="text-xl font-semibold leading-snug text-popover-foreground" role="header">{copy().title}</Text>
          {copy().description ? (
            // AlertDialogDescription: max-h-[min(24rem,60dvh)], scrolling, selectable.
            <Scroll style={{ maxHeight: Math.min(384, windowSize().height * 0.6) }}>
              <Text class="text-sm text-muted-foreground">{copy().description}</Text>
            </Scroll>
          ) : null}
        </View>
        <View class="flex-row justify-end gap-2 border-t border-border px-6 py-4" style={{ backgroundColor: tokenAlpha("muted", 0.72) }}>
          <View
            role="button"
            accessibilityLabel="Cancel"
            ref={(node: ViewRef | null) => { cancelNode = node; }}
            onFocus={() => focused.set("cancel")}
            onPress={() => respondToConfirmDialog(false)}
            class="h-8 items-center justify-center rounded-lg border border-input bg-popover px-3 hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out"
          >
            <Text class="text-sm font-medium text-foreground">Cancel</Text>
          </View>
          <View
            role="button"
            accessibilityLabel="Confirm"
            onFocus={() => focused.set("confirm")}
            onBlur={() => focused.set("cancel")}
            onPress={() => respondToConfirmDialog(true)}
            class={destructive() ? "h-8 items-center justify-center rounded-lg bg-destructive px-3 active:scale-[0.97] transition-transform duration-150 ease-in-out" : "h-8 items-center justify-center rounded-lg bg-primary px-3 active:scale-[0.97] transition-transform duration-150 ease-in-out"}
          >
            <Text class={destructive() ? "text-sm font-medium text-white" : "text-sm font-medium text-primary-foreground"}>{confirmLabel()}</Text>
          </View>
        </View>
      </View>
    </Dialog>
  );
}
