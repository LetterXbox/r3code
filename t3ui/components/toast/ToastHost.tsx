// ToastHost.tsx: the stack of toasts at the top right (ToastProvider's viewport in the web app: inset 32, below the
// 52 pt top bar, 360 wide). The newest toast is in front; up to three show, the older ones peek out beneath it and the
// stack opens out while the pointer is on it. Each has a corner dismiss button, an error's reason gets a copy button,
// and the action buttons sit at the end of the row.
import type { MotionSpec } from "nsh";
import { AnimatedValue, cleanup, Clipboard, computed, effect, signal, Text, untracked, View } from "nsh";
import { Image } from "nsh";
import { createHover } from "../hoverReveal";
import { Icon } from "../Icons";
import { Spinner } from "../sidebar/Spinner";
import { measureInto, useFloatingRect, type PageRect } from "../rightPanel/nativeOcclusion";
import circleAlert from "./icons/circle-alert.svg";
import circleCheck from "./icons/circle-check.svg";
import triangleAlert from "./icons/triangle-alert.svg";
import messageCircleQuestion from "./icons/message-circle-question.svg";
import shieldQuestion from "./icons/shield-question.svg";
import starMark from "./icons/star.svg";
import downloadMark from "../../icons/download.svg";
import checkMark from "../../icons/check.svg";
import copyMark from "../../icons/copy.svg";
import { token } from "nsh";
import { enterStyle } from "../motion/Motion";
import { EASE_TOAST, departures, stackOffset, TOAST_ESTIMATED_HEIGHT, toastStackCollapse, toastStackExpand, trackArrivals, TOAST_INSET, TOAST_MS, toastEnterX, toastExitX } from "../motion/motionTokens";
import { dismissToast, setActiveThreadReader, setToastsHovered, toastsHovered, visibleToasts, type ToastAction, type ToastActionVariant, type ToastItem } from "./toastState";
import { openThread } from "../../store";
import { tokenAlpha } from "../composer/tokenColor";

// Toasts raised with a `threadRef` show only on that thread (ui/toast.tsx useActiveThreadRefFromRoute).
setActiveThreadReader(() => { const id = openThread()?.id; return id ? { threadId: id } : null; });

// When each visible toast first appeared; an id leaves the map when its toast leaves the list.
const toastArrivals = computed<Map<string, number>>((previous) => trackArrivals(previous ?? new Map(), visibleToasts().map((toast) => toast.id), Date.now()));
const LEADING_MARKS = { "circle-check": circleCheck, "circle-alert": circleAlert, "shield-question": shieldQuestion, "message-circle-question": messageCircleQuestion, star: starMark, download: downloadMark } as const;
const LEADING_TINTS = { success: "success-foreground", warning: "warning-foreground", destructive: "destructive-foreground", info: "info-foreground" } as const;

function ToastIcon(props: { type: ToastItem["type"]; leading?: ToastItem["leadingIcon"] }) {
  const mark = (src: typeof circleAlert, tint: string) => <Image src={src} fadeDuration={0} style={{ width: 16, height: 16, tintColor: tint }} />;
  if (props.leading) return mark(LEADING_MARKS[props.leading.name], token(LEADING_TINTS[props.leading.tone]));
  switch (props.type) {
    case "error": return mark(circleAlert, token("destructive"));
    case "success": return mark(circleCheck, token("success"));
    case "warning": return mark(triangleAlert, token("warning"));
    case "info": return <Icon name="info" size={16} tint={token("info")} />;
    case "loading": return <Spinner size={16} tint={token("muted-foreground")} />;
    default: return null;
  }
}

const BUTTON_CLASS: Record<ToastActionVariant, { box: string; text: string }> = {
  default: { box: "bg-primary", text: "text-primary-foreground" },
  secondary: { box: "bg-secondary", text: "text-secondary-foreground" },
  outline: { box: "border border-input bg-popover hover:bg-accent-50", text: "text-foreground" },
  ghost: { box: "hover:bg-accent", text: "text-foreground" },
  destructive: { box: "bg-destructive", text: "text-white" },
  "destructive-outline": { box: "border border-input bg-popover hover:bg-accent-50", text: "text-destructive-foreground" },
};

// Like Base UI's Toast.Action, a press only runs the handler: it closes the toast itself when it should.
function ActionButton(props: { action: ToastAction; primary: boolean }) {
  const variant = props.action.variant ?? (props.primary ? "default" : "outline");
  const style = BUTTON_CLASS[variant];
  return (
    <View
      role="button"
      accessibilityLabel={props.action.label}
      disabled={props.action.disabled === true}
      onPress={() => props.action.run()}
      class={`h-6 shrink-0 items-center justify-center rounded-lg px-2 active:scale-[0.97] transition-transform duration-150 ease-in-out ${style.box} ${props.action.disabled ? "opacity-64" : ""}`}
    >
      <Text class={`text-xs font-medium ${style.text}`}>{props.action.label}</Text>
    </View>
  );
}

/** CopyErrorButton: copies the error's reason; the mark turns to a check for a moment. */
function CopyErrorButton(props: { text: string }) {
  const copied = signal(false);
  // Button icon-micro ghost-muted with `rounded-md text-muted-foreground/80 hover:bg-transparent hover:text-muted-foreground`.
  const hover = createHover();
  const label = () => (copied() ? "Copied error" : "Copy error");
  return (
    <View
      role="button"
      accessibilityLabel={label()}
      tooltip={label()}
      onPress={() => {
        void Clipboard.writeText(props.text).then(() => {
          copied.set(true);
          setTimeout(() => copied.set(false), 2000);
        }).catch(() => undefined);
      }}
      {...hover.bind}
      class="size-5 items-center justify-center rounded-md active:scale-[0.97] transition-transform duration-150 ease-in-out"
    >
      <Image src={copied() ? checkMark : copyMark} fadeDuration={0} style={{ width: 12, height: 12, tintColor: copied() ? token("success") : hover.hovered() ? token("muted-foreground") : token("muted-foreground-80") }} />
    </View>
  );
}

/** The web's expandable description (`expandableDescriptionTrigger`, ui/toast.tsx): the description itself is the
 * trigger, underlined on hover, with a ChevronDown/Up (size-3.5, opacity-80) at its end; "Show requests" is its label. */
function ExpandableRows(props: { expandable: NonNullable<ToastItem["expandable"]>; description: string }) {
  const open = signal(false);
  const hover = createHover();
  return (
    <View class="gap-2">
      <View role="button" accessibilityLabel={open() ? props.expandable.labels.collapse : props.expandable.labels.expand} onPress={() => open.set(!open())} {...hover.bind} class={`min-w-0 w-full flex-row items-start gap-1.5 rounded-sm transition-colors duration-150 ease-in-out ${hover.hovered() ? "bg-muted-40" : ""}`}>
        <Text class={`min-w-0 flex-1 text-sm text-muted-foreground ${hover.hovered() ? "underline" : ""}`}>{props.description}</Text>
        <View class="h-5 justify-center opacity-80" style={{ transform: open() ? "rotate(180deg)" : "rotate(0deg)" }}><Icon name="chevron-down" size={14} tint={token("muted-foreground")} /></View>
      </View>
      {open() ? (
        <View class="gap-2.5">
          {props.expandable.rows.map((row) => (
            <View class="min-w-0 gap-0.5 border-b border-border-60 pb-2">
              <Text class="text-xs font-medium text-foreground">{row.title}</Text>
              <Text class="text-3xs text-muted-foreground">{row.detail}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Toast(props: { toast: ToastItem; expandFrom?: number; aboveHeight?: number; onHeight?: (height: number) => void }) {
  // Read through `props` each time: a toast raised again under its id (clone progress) updates in place.
  const toast = () => props.toast;
  const copyText = () => (toast().type === "error" && !toast().hideCopyButton && toast().description ? toast().description! : null);
  const hasControls = () => copyText() !== null || toast().actions.length > 0;
  // deriveToastBodyDescriptor: the stacked layout needs a visible action and `actionLayout: "stacked-end"`.
  const stackedLayout = () => toast().actions.length > 0 && toast().actionLayout !== "inline";
  const dismissHover = createHover();
  // ui/toast.tsx:627: a top-right toast enters from past the right edge, .5s cubic-bezier(.22,1,.36,1), only as it
  // arrives (not when it comes to the front of the stack or the stack opens out).
  const arrivedAt = untracked(() => toastArrivals().get(toast().id));
  const enter = arrivedAt !== undefined && Date.now() - arrivedAt < TOAST_MS ? enterStyle(toastEnterX(360 + TOAST_INSET))
    // ui/toast.tsx:614-624: as the stack opens out, a toast behind the front one moves from its peek (index x 12 pt down
    // the stack, scale 1 - index x .1) to its own place, .5s.
    : props.expandFrom ? enterStyle(toastStackExpand(props.expandFrom, props.aboveHeight))
    : undefined;
  return (
    <View
      style={enter}
      onLayout={props.onHeight ? (event) => props.onHeight!(event.bounds.size.height) : undefined}
      role="alert"
      selectable
      accessibilityLabel={toast().title}
      class="relative w-full rounded-lg border border-border bg-popover-84 shadow-xl"
    >
      {/* ui/toast.tsx Toast.Content: stacked-end is `flex flex-col gap-2 py-2.5 pr-3.5`, inline is `py-3 flex items-center
          justify-between gap-1.5` with `pr-6` beside trailing controls, else `pr-3.5`; the title row takes `pr-6` (clear of the
          corner dismiss) when inline with no controls. */}
      <View class={stackedLayout() ? "gap-2 py-2.5 pl-3.5 pr-3.5" : `flex-row items-center justify-between gap-1.5 py-3 pl-3.5 ${hasControls() ? "pr-6" : "pr-3.5"}`}>
        <View class={stackedLayout() ? "min-w-0 gap-0.5 pr-5" : "min-w-0 flex-1 gap-0.5"}>
          <View class={`min-w-0 flex-row gap-2 ${!stackedLayout() && !hasControls() ? "pr-6" : ""}`}>
            {toast().type || toast().leadingIcon ? <View class="h-5 w-4 items-center justify-center"><ToastIcon type={toast().type} leading={toast().leadingIcon} /></View> : null}
            <Text class="min-w-0 flex-1 text-sm font-medium leading-5 text-popover-foreground">{toast().title}</Text>
          </View>
          {/* errorDescriptionClampClass: an error description of 180+ characters is clamped to four lines. */}
          {toast().expandable ? <ExpandableRows expandable={toast().expandable!} description={toast().description ?? ""} /> : toast().description ? <Text class={`text-sm text-muted-foreground ${toast().type === "error" && toast().description!.length >= 180 ? "line-clamp-4" : ""}`}>{toast().description}</Text> : null}
        </View>
        {hasControls() ? (
          <View class={stackedLayout() ? "w-full flex-row items-center justify-end gap-1.5" : "shrink-0 flex-row items-center gap-1.5"}>
            {copyText() !== null ? <CopyErrorButton text={copyText()!} /> : null}
            {toast().actions.map((action, index) => <ActionButton action={action} primary={index === toast().actions.length - 1} />)}
          </View>
        ) : null}
      </View>
      <View class="absolute -right-1.5 -top-1.5 z-20">
        <View
          role="button"
          accessibilityLabel="Dismiss notification"
          onPress={() => dismissToast(toast().id)}
          {...dismissHover.bind}
          // toastCornerOrbClass: `bg-popover/92 text-muted-foreground hover:bg-popover hover:text-foreground`, a plain button
          // (no pressed scale).
          class="size-6 items-center justify-center rounded-full border border-border-60 shadow-sm transition-colors duration-150 ease-in-out"
          style={{ backgroundColor: dismissHover.hovered() ? token("popover") : tokenAlpha("popover", 0.92) }}
        >
          <Icon name="x" size={12} tint={dismissHover.hovered() ? token("foreground") : token("muted-foreground")} />
        </View>
      </View>
    </View>
  );
}

// ToastRoot.js SWIPE_THRESHOLD: a drag of more than 40 pt in an allowed direction dismisses the toast.
export const TOAST_SWIPE_THRESHOLD = 40;

/** ui/toast.tsx swipeDirection for the top-right viewport: ["right", "up"]. Whether a release dismisses. */
export function toastSwipeDismisses(translation: { x: number; y: number }): boolean {
  return translation.x > TOAST_SWIPE_THRESHOLD || -translation.y > TOAST_SWIPE_THRESHOLD;
}

// A toast swiped away leaves from where it was let go, on in the swipe's direction (ui/toast.tsx:631-638
// data-swipe-direction: right -> translateX(movement + 100% + inset), up -> translateY(movement - 100% - inset)).
const swipedAway = new Map<string, { direction: "right" | "up"; x: number; y: number; height: number }>();

/** The leaving motion of a swiped toast, or null for a toast that was not swiped. */
export function toastSwipeExit(id: string): MotionSpec | null {
  const swipe = swipedAway.get(id);
  if (!swipe) return null;
  return swipe.direction === "right"
    ? { keyframes: { opacity: [1, 0], translateX: [swipe.x, swipe.x + 360 + TOAST_INSET], translateY: [swipe.y, swipe.y] }, duration: TOAST_MS, easing: EASE_TOAST, ignoreReduceMotion: true }
    : { keyframes: { opacity: [1, 0], translateX: [swipe.x, swipe.x], translateY: [swipe.y, swipe.y - swipe.height - TOAST_INSET] }, duration: TOAST_MS, easing: EASE_TOAST, ignoreReduceMotion: true };
}

/** Which way a release past the threshold dismisses: the larger allowed travel. */
export function toastSwipeDirection(translation: { x: number; y: number }): "right" | "up" | null {
  if (!toastSwipeDismisses(translation)) return null;
  return translation.x - TOAST_SWIPE_THRESHOLD >= -translation.y - TOAST_SWIPE_THRESHOLD ? "right" : "up";
}

/** Swipe to dismiss: the toast follows the drag; a release past the threshold to the right or up closes it, any
 * other release puts it back. */
function SwipeToDismiss(props: { id: string; children: any }) {
  const x = new AnimatedValue(0);
  const y = new AnimatedValue(0);
  let height = TOAST_ESTIMATED_HEIGHT;
  return (
    <View
      accessibilityLabel="Swipe to dismiss"
      pan={{ x, y }}
      style={{ transform: [{ translateX: x }, { translateY: y }] }}
      onLayout={(event) => { height = event.bounds.size.height; }}
      onPanEnd={(event) => {
        x.set(0);
        y.set(0);
        const direction = event.cancelled ? null : toastSwipeDirection(event.translation);
        if (!direction) return;
        swipedAway.set(props.id, { direction, x: event.translation.x, y: event.translation.y, height });
        setTimeout(() => swipedAway.delete(props.id), TOAST_MS * 2);
        dismissToast(props.id);
      }}
    >
      {props.children}
    </View>
  );
}

/** A toast behind the front one while the stack is closed: only its edge shows, narrower the further back it is. */
function Peek(props: { depth: number }) {
  return (
    <View
      class="h-3 rounded-b-lg border border-t-0 border-border bg-popover-84 shadow-md"
      // --toast-scale = 1 - index x .1 around the centre: a 360 pt toast is 18 pt narrower each side per step back.
      style={{ marginLeft: props.depth * 18, marginRight: props.depth * 18 }}
    />
  );
}

export function ToastHost() {
  // A native WebView is drawn above every GPUI element: only a WebView the toast stack overlaps steps aside.
  const stackRect = signal<PageRect | null>(null);
  let stackNode: { measure(): Promise<any> } | undefined;
  const stacked = () => visibleToasts().length > 1 && !toastsHovered();
  // ui/toast.tsx:628,630: a closed toast fades and slides back out past the right edge over .5s. The store drops it at
  // once, so the host keeps a copy over the stack (inert) until its exit has played.
  const leaving = signal<ToastItem[]>([]);
  // As the stack closes (ui/toast.tsx:614-624), the toasts behind the front one move back up into their peek, shrink
  // and their content fades (toast.tsx:678, 250ms); the host keeps copies at their open places while that plays.
  const collapsing = signal<Array<{ toast: ToastItem; index: number; top: number }>>([]);
  // The stack's rectangle stays registered while a toast is leaving or collapsing, so a WebView cannot draw over it.
  useFloatingRect(() => (visibleToasts().length > 0 || leaving().length > 0 || collapsing().length > 0 ? stackRect() : null), "toasts");
  // Each toast's measured height (onLayout), for the stack's offsets.
  const heights = new Map<string, number>();
  const aboveOf = (list: readonly ToastItem[], index: number) => stackOffset(list.slice(0, index).map((toast) => heights.get(toast.id) ?? TOAST_ESTIMATED_HEIGHT), 12);
  let wasStacked = untracked(stacked);
  effect(() => {
    const now = stacked();
    if (now && !wasStacked) {
      const list = untracked(visibleToasts);
      const copies = list.slice(1).map((toast, at) => ({ toast, index: at + 1, top: aboveOf(list, at + 1) }));
      collapsing.set(copies);
      const timer = setTimeout(() => { timers.delete(timer); collapsing.set([]); }, TOAST_MS);
      timers.add(timer);
    } else if (!now) collapsing.set([]);
    wasStacked = now;
  });
  let expandedAt = 0;
  effect(() => { if (!stacked() && untracked(visibleToasts).length > 1) expandedAt = Date.now(); });
  let shown: ToastItem[] = untracked(visibleToasts);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  effect(() => {
    const next = visibleToasts();
    const gone = departures(shown, next, (toast) => toast.id).filter((toast) => shown.indexOf(toast) === 0 || !untracked(stacked));
    shown = next;
    if (gone.length === 0) return;
    untracked(() => leaving.set([...leaving(), ...gone]));
    const timer = setTimeout(() => {
      timers.delete(timer);
      leaving.set(leaving().filter((toast) => !gone.includes(toast)));
    }, TOAST_MS);
    timers.add(timer);
  });
  cleanup(() => { for (const timer of timers) clearTimeout(timer); });
  return (
    <View
      style={{ pointerEvents: "box-none" }}
      accessibilityLabel="Notifications"
      class="absolute right-8 top-[84px] z-50 w-[360px] max-w-[92%]"
    >
      {visibleToasts().length > 0 ? (
        <View
          accessibilityLabel="Notification stack"
          ref={(node: any) => { stackNode = node; }}
          onLayout={() => measureInto(stackNode, stackRect)}
          class="gap-3"
          onMouseEnter={() => setToastsHovered(true)}
          onMouseLeave={() => setToastsHovered(false)}
        >
          <Each of={visibleToasts()} key={(toast: ToastItem) => toast.id}>
            {(toast, index) => () => (index() === 0 || !stacked() ? <SwipeToDismiss id={toast().id}><Toast toast={toast()} onHeight={(height) => heights.set(toast().id, height)} expandFrom={index() > 0 && Date.now() - expandedAt < TOAST_MS ? index() : 0} aboveHeight={index() > 0 ? untracked(() => aboveOf(visibleToasts(), index())) : 0} /></SwipeToDismiss> : null)}
          </Each>
          {stacked() ? (
            <View class="-mt-3">
              {visibleToasts().slice(1).map((_, index) => <Peek depth={index + 1} />)}
            </View>
          ) : null}
        </View>
      ) : null}
      <Each of={collapsing()} key={(entry: { toast: ToastItem; index: number; top: number }) => entry.toast.id}>
        {(entry) => (
          <View class="absolute left-0 right-0" style={[{ top: entry().top, pointerEvents: "none" }, enterStyle(toastStackCollapse(entry().index, entry().top))]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Toast toast={entry().toast} />
          </View>
        )}
      </Each>
      <Each of={leaving()} key={(toast: ToastItem) => toast.id}>
        {(toast) => (
          <View class="absolute left-0 right-0 top-0" style={[{ pointerEvents: "none" }, enterStyle(toastSwipeExit(toast().id) ?? toastExitX(360 + TOAST_INSET))]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Toast toast={toast()} />
          </View>
        )}
      </Each>
    </View>
  );
}
