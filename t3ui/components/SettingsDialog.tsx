// The settings pages' modal: the web's Dialog (DialogPopup, DialogHeader, DialogPanel, DialogFooter)
// as a real nsh Dialog, so it draws above the page, the sidebar and every other overlay, takes
// Escape and backdrop presses as closes, and is not an inline panel. Pass `footer` for the bordered
// action bar (`DialogFooter`); `Cancel` and the primary action live there.
import { FadeScroll } from "./FadeScroll";
import { effect, keymap, Scroll, Text, View } from "nsh";
import { Dialog } from "nsh/base";
import { Icon } from "./Icons";
import { dialogBackdropStyle, keepPressInDialog } from "./dialogSurface";
import { EscapeCancel } from "./EscapeCancel";
import { presenceStyle } from "./motion/Motion";
import { dialogScaleEnter, dialogScaleExit } from "./motion/motionTokens";

export function SettingsDialog(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  /** Popup width in points (the web's `max-w-lg` is 512, `sm:max-w-3xl` 768). */
  width?: number;
  testID?: string;
  children?: any;
  footer?: any;
  footerVariant?: "bare";
}) {
  // The page under the dialog binds Escape itself (Settings closes), and a key that fires a binding never reaches the dialog's
  // own close, so the dialog binds it too while it is up: it is the newer binding, and Escape closes the dialog first.
  effect(() => {
    if (!props.open) return;
    return keymap.bind({ escape: () => props.onClose() }, { when: "always" });
  });
  return (
    <Dialog
      open={props.open}
      animation="fade"
      testID={props.testID}
      onOpenChange={({ open }) => { if (!open) props.onClose(); }}
      backdropStyle={dialogBackdropStyle()}
      style={{ margin: "auto", width: props.width ?? 512, maxWidth: "92%", maxHeight: "92%", flexDirection: "column" }}
    >
      {props.open ? <EscapeCancel onCancel={() => props.onClose()} /> : null}
      {/* The card is bounded by the popup and its body scrolls (the web's DialogPanel); unbounded, the scheduled-task
          editor drew past the window with its footer out of reach. It takes presses itself: see keepPressInDialog. */}
      <View class="relative max-h-full min-h-0 shrink flex-col overflow-hidden rounded-2xl border border-border bg-background" accessibilityLabel={props.title}
        onPress={keepPressInDialog} style={presenceStyle(dialogScaleEnter, dialogScaleExit, () => props.open)}>
        <View class="shrink-0 gap-2 p-6 pb-3">
          <Text class="text-xl font-semibold leading-snug text-popover-foreground">{props.title}</Text>
          {props.description ? <Text class="text-sm text-muted-foreground">{props.description}</Text> : null}
        </View>
        <View role="button" accessibilityLabel="Close" tooltip="Close (Esc)" onPress={props.onClose}
          class="absolute right-2 top-2 size-8 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out">
          <Icon name="x" size={16} />
        </View>
        {props.children ? <FadeScroll class="min-h-0 shrink" contentClass="gap-4 px-6 pt-1 pb-6">{props.children}</FadeScroll> : null}
        {props.footer ? <View class={`shrink-0 flex-row justify-end gap-2 px-6 py-4 ${props.footerVariant === "bare" ? "" : "border-t border-border bg-muted-72"}`}>{props.footer}</View> : null}
      </View>
    </Dialog>
  );
}

/** A field label over its input, as the dialogs lay them out (`text-xs font-medium` over the control). */
export function DialogField(props: { label: string; children: any; class?: string }) {
  return (
    <View class={`gap-1.5 ${props.class ?? ""}`}>
      <Text class="text-xs font-medium text-foreground">{props.label}</Text>
      {props.children}
    </View>
  );
}
