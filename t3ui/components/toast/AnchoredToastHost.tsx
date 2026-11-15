// Draws the anchored toasts (anchoredToast.ts): each one centred under its anchor's page rectangle, `sideOffset` 4 below it, in the
// popover look (dropdown-glass in the web). The tooltip style is a rounded-md box with the title only; the full one has the
// dismiss orb and the description. A native WebView the toast overlaps steps aside.
import { cleanup, computed, effect, signal, Text, untracked, View } from "nsh";
import { presenceStyle } from "../motion/Motion";
import { departures, DURATION_DEFAULT_MS, popoverEnter, popoverExit } from "../motion/motionTokens";
import { Icon } from "../Icons";
import { useFloatingRect } from "../rightPanel/nativeOcclusion";
import { ANCHORED_TOAST_SIDE_OFFSET, anchoredToasts, closeAnchoredToast, type AnchoredToastItem } from "./anchoredToast";

/** The width an anchored toast may take (max-w-64 in the web). */
export const ANCHORED_TOAST_WIDTH = 256;

function AnchoredToast(props: { item: AnchoredToastItem; leaving?: () => boolean }) {
  const item = () => props.item;
  useFloatingRect(() => ({ x: item().rect.x + item().rect.width / 2 - ANCHORED_TOAST_WIDTH / 2, y: item().rect.y + item().rect.height + ANCHORED_TOAST_SIDE_OFFSET, width: ANCHORED_TOAST_WIDTH, height: 40 }), "anchored toast");
  return (
    <View
      style={{ pointerEvents: props.leaving?.() ? "none" : "box-none", left: item().rect.x + item().rect.width / 2 - ANCHORED_TOAST_WIDTH / 2, top: item().rect.y + item().rect.height + ANCHORED_TOAST_SIDE_OFFSET, width: ANCHORED_TOAST_WIDTH }}
      class="absolute z-50 items-center"
    >
      <View role="alert" accessibilityLabel={item().title} style={presenceStyle(popoverEnter, popoverExit, () => !props.leaving?.())} class={`relative border border-border bg-popover-84 shadow-xl ${item().tooltipStyle ? "rounded-md px-2 py-1" : "rounded-lg py-3 pl-3.5 pr-3.5"}`}>
        {item().tooltipStyle ? (
          <Text class="text-xs text-popover-foreground">{item().title}</Text>
        ) : (
          <View class="gap-0.5 pr-5">
            <Text class="text-sm font-medium text-popover-foreground">{item().title}</Text>
            {item().description ? <Text class="text-sm text-muted-foreground">{item().description}</Text> : null}
          </View>
        )}
        {item().tooltipStyle ? null : (
          <View class="absolute -right-1.5 -top-1.5 z-20">
            <View role="button" accessibilityLabel="Dismiss notification" onPress={() => closeAnchoredToast(item().id)} class="size-6 items-center justify-center rounded-full border border-border-60 bg-popover shadow-sm hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out">
              <Icon name="x" size={12} />
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

export function AnchoredToastHost() {
  // ui/toast.tsx:740: the popup scales .98 and fades both in and out, `transition-[scale,opacity]` (150ms default). A closed toast stays
  // drawn (inert, its floating rect still registered with the WebView occlusion) for that long.
  const leaving = signal<AnchoredToastItem[]>([]);
  let previous: readonly AnchoredToastItem[] = untracked(anchoredToasts);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  effect(() => {
    const next = anchoredToasts();
    untracked(() => {
      const gone = departures(previous, next, (toast) => toast.id);
      previous = next;
      if (gone.length === 0) return;
      leaving.set([...leaving().filter((toast) => !gone.some((left) => left.id === toast.id)), ...gone]);
      const timer = setTimeout(() => {
        timers.delete(timer);
        leaving.set(leaving().filter((toast) => !gone.includes(toast)));
      }, DURATION_DEFAULT_MS);
      timers.add(timer);
    });
  });
  cleanup(() => { for (const timer of timers) clearTimeout(timer); });
  const shown = computed(() => [
    ...anchoredToasts().map((toast) => ({ id: toast.id, toast, leaving: false })),
    ...leaving().filter((toast) => !anchoredToasts().some((live) => live.id === toast.id)).map((toast) => ({ id: toast.id, toast, leaving: true })),
  ]);
  return (
    <View style={{ pointerEvents: "box-none" }} class="absolute inset-0 z-50" accessibilityLabel="Anchored notifications">
      <Each of={shown()} key={(row: { id: string; toast: AnchoredToastItem; leaving: boolean }) => row.id}>{(row) => () => <AnchoredToast item={row().toast} leaving={() => row().leaving} />}</Each>
    </View>
  );
}
