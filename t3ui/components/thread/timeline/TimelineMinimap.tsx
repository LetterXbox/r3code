// chat/TimelineMinimap.tsx: a rail of short strips down the left gutter of the transcript, one per user message. Strips in
// the viewport are bright; hovering the rail fans the strips out around the pointer (fisheye), shows that turn's message
// and the start of its answer in a card, and a press scrolls to it. Previous / next turn arrows sit above and below the
// rail and appear on hover. Fewer than two user messages show nothing; a gutter under 48pt shows the rail only on hover.
//
// The focused rail takes Up / Down / Home / End / Enter / Space (keymap while focused). A drag that did not start on the rail
// (a text selection crossing it) passes through: the rail neither previews nor selects until the button is up. A wheel over
// the rail scrolls the transcript (timelineMinimapWheel.ts) through the view's `onWheel`, which needs host patch 0012; on a
// host without it the rail takes no wheel at all.
import { computed, effect, keymap, signal, Text, token, View, windowSize } from "nsh";
import { stepMinimapIndex } from "./minimapLogic";
import type { ViewRef } from "nsh";
import { tokenAlpha } from "../../composer/tokenColor";
import { ComposerIcon } from "../../composer/ComposerIcon";
import { measureInto, useFloatingRect } from "../../rightPanel/nativeOcclusion";
import type { PageRect } from "../../rightPanel/nativeOcclusion";
import {
  resolveTimelineMinimapPreview,
  TIMELINE_MINIMAP_MIN_ITEMS,
  timelineMinimapCurrentIndex,
  timelineMinimapHasPersistentGutter,
  timelineMinimapHeight,
  timelineMinimapHitStripWidth,
  timelineMinimapIndexFromPointer,
  timelineMinimapInteractiveWidth,
  timelineMinimapNavigationInteractive,
  timelineMinimapPreviewShift,
  timelineMinimapRowVisible,
  timelineMinimapStripScale,
  timelineMinimapTopPercent,
} from "./minimapLogic";
import type { TimelineMinimapItem } from "./minimapLogic";

/** `left-3`: the rail's inset from the lane's edge. */
const RAIL_LEFT = 12;
/** `left-8`: the card's inset from the rail. */
const CARD_LEFT = 32;
const CARD_WIDTH = 320;
const STRIP_WIDTH = 24;
const NAV_SIZE = 20;

function NavigationButton(props: { direction: "previous" | "next"; disabled: boolean; interactive: boolean; railHeight: () => number; onPress: () => void }) {
  const previous = props.direction === "previous";
  const label = previous ? "Previous turn" : "Next turn";
  const hovered = signal(false);
  const focused = signal(false);
  return (
    <View
      role="button"
      accessibilityLabel={label}
      tooltip={label}
      disabled={props.disabled || !props.interactive}
      onPress={props.onPress}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      onFocus={() => focused.set(true)}
      onBlur={() => focused.set(false)}
      class={`absolute items-center justify-center rounded-sm transition-opacity duration-150 ${hovered() && props.interactive && !props.disabled ? "bg-accent" : ""} ${props.disabled ? "opacity-64" : ""}`}
      style={{
        left: 4 - NAV_SIZE / 2,
        width: NAV_SIZE,
        height: NAV_SIZE,
        top: previous ? -NAV_SIZE - 2 : props.railHeight() + 2,
        opacity: hovered() || focused() ? 1 : 0,
        pointerEvents: props.interactive ? "auto" : "none",
      }}
    >
      <ComposerIcon name={previous ? "chevron-up" : "chevron-down"} size={16} tint={tokenAlpha("foreground", 0.9)} />
    </View>
  );
}

/** passThrough: a drag from elsewhere crossed the rail, which lets the pointer through until the button is up (the transcript
 * around clears it: `releaseMinimapPassThrough` on a buttonless mouse move). */
export const minimapPassThrough = signal(false);
export function releaseMinimapPassThrough(pressedButton: string | null) { if (pressedButton === null && minimapPassThrough()) minimapPassThrough.set(false); }

export function TimelineMinimap(props: {
  items: () => readonly TimelineMinimapItem[];
  /** The transcript lane's inset each side: the gutter the rail lives in. */
  gutter: () => number;
  /** The rows the list shows now (first and last index), from its viewability report. */
  range: () => { start: number; end: number } | null;
  onSelect: (item: TimelineMinimapItem) => void;
  /** A wheel over the rail (forwardWheelToTimeline): the transcript scrolls by it. */
  onWheel?: (event: { deltaY: number; precise: boolean; ctrl: boolean }) => void;
}) {
  const items = () => props.items();
  const count = () => items().length;
  const activeIndex = signal<number | null>(null);
  const resolvedActive = () => { const index = activeIndex(); return index !== null && index < count() ? index : null; };
  const activeItem = computed(() => { const index = resolvedActive(); return resolveTimelineMinimapPreview(index === null ? null : items()[index] ?? null); });
  const persistent = () => timelineMinimapHasPersistentGutter(props.gutter());
  const hitWidth = () => timelineMinimapHitStripWidth(props.gutter());
  const railHeight = () => timelineMinimapHeight(count(), windowSize().height);
  const showCard = () => activeItem() !== null;
  const interactiveWidth = () => timelineMinimapInteractiveWidth(hitWidth(), showCard());
  const currentIndex = () => { const index = timelineMinimapCurrentIndex(props.range(), items().map((item) => item.rowIndex)); return index !== null && index >= 0 && index < count() ? index : null; };
  const previousItem = () => { const index = currentIndex(); return index === null ? null : items()[index - 1] ?? null; };
  const nextItem = () => { const index = currentIndex(); return index === null ? null : items()[index + 1] ?? null; };
  const navigationInteractive = () => timelineMinimapNavigationInteractive(hitWidth());
  // TimelineMinimap's strip button: with the keyboard focus, Up/Down move the preview, Home/End jump, Enter/Space select.
  const focused = signal(false);
  effect(() => {
    if (!focused()) return;
    if (activeIndex() === null) activeIndex.set(currentIndex() ?? 0);
    const move = (key: "up" | "down" | "home" | "end") => () => activeIndex.set(stepMinimapIndex(resolvedActive(), count(), key));
    const select = () => { const index = resolvedActive(); const selected = index === null ? null : items()[index] ?? null; if (selected) props.onSelect(selected); };
    return keymap.bind({ up: move("up"), down: move("down"), home: move("home"), end: move("end"), enter: select, space: select }, { when: "always" });
  });

  // pressedOnStripRef / passThrough: a press that went down on the rail drags its preview; any other drag passes through.
  let pressedOnStrip = false;
  const passThrough = minimapPassThrough;
  const cardHeight = signal(0);
  const cardRect = signal<PageRect | null>(null);
  let cardNode: ViewRef | null = null;
  // The card draws over the transcript and can reach a WebView beside it: only a WebView it overlaps steps aside.
  useFloatingRect(() => (showCard() ? cardRect() : null), "timeline minimap preview");

  const visible = () => count() >= TIMELINE_MINIMAP_MIN_ITEMS;
  const railOpacity = () => (persistent() || activeIndex() !== null ? 1 : 0);

  return (
    <>
      {visible() ? (
        <View
          class="absolute inset-y-0 left-0 justify-center transition-opacity duration-150"
          style={{ width: 72, pointerEvents: "box-none", opacity: railOpacity() }}
          testID="timeline-minimap"
        >
          <View
            class="relative"
            style={{ marginLeft: RAIL_LEFT, width: interactiveWidth(), height: railHeight(), pointerEvents: hitWidth() > 0 && !passThrough() ? "auto" : "none" }}
            accessibilityLabel={`Jump to message: ${activeItem()?.userText ?? "User message"}`}
            role="button"
            {...({ onWheel: (event: { deltaY: number; precise: boolean; modifiers: { control: boolean } }) => props.onWheel?.({ deltaY: event.deltaY, precise: event.precise, ctrl: event.modifiers.control }) } as object)}
            onPressDown={() => { pressedOnStrip = true; }}
            onPressUp={() => { pressedOnStrip = false; }}
            onMouseMove={(event) => {
              // A drag that started elsewhere crosses the rail without moving its preview.
              if (event.pressedButton !== null && !pressedOnStrip) { passThrough.set(true); return; }
              if (event.pressedButton === null) { pressedOnStrip = false; passThrough.set(false); }
              // A drag that started on the strip keeps moving the preview (pressedOnStrip); release selects it.
              if (showCard() && event.position.x >= CARD_LEFT) return;
              activeIndex.set(timelineMinimapIndexFromPointer({ itemCount: count(), railTop: 0, railHeight: railHeight(), pointerY: event.position.y }));
            }}
            onMouseLeave={() => activeIndex.set(null)}
            onFocus={() => focused.set(true)}
            onBlur={() => { focused.set(false); activeIndex.set(null); }}
            onPress={(event) => {
              if (passThrough()) return;
              const index = timelineMinimapIndexFromPointer({ itemCount: count(), railTop: 0, railHeight: railHeight(), pointerY: event.position.y });
              const selected = index === null ? null : items()[index] ?? null;
              if (selected) props.onSelect(selected);
            }}
          >
            <NavigationButton direction="previous" disabled={previousItem() === null} interactive={navigationInteractive()} railHeight={railHeight} onPress={() => { const item = previousItem(); if (item) props.onSelect(item); }} />
            <View class="absolute top-0 h-full w-px" style={{ left: RAIL_LEFT, backgroundColor: tokenAlpha("border", 0.15) }} />
            <Each of={items()} key={(item) => item.id}>
            {(item, index) => {
              const distance = () => { const active = resolvedActive(); return active === null ? null : Math.abs(index() - active); };
              const top = () => (timelineMinimapTopPercent(index(), count()) / 100) * railHeight() - 1;
              const inView = () => timelineMinimapRowVisible(item().rowIndex, props.range());
              const highlighted = () => {
                if (inView()) return true;
                const r = props.range();
                const anyInView = items().some((entry) => timelineMinimapRowVisible(entry.rowIndex, r));
                return !anyInView && index() === currentIndex();
              };
              return (
                <View
                  class="absolute h-0.5 rounded-full transition-transform duration-150"
                  style={{
                    left: 0,
                    width: STRIP_WIDTH,
                    top: top(),
                    transformOrigin: "left center",
                    transform: [{ scaleX: timelineMinimapStripScale(distance()) }],
                    backgroundColor: tokenAlpha("muted-foreground", distance() === 0 ? 0.6 : 0.25),
                    pointerEvents: "none",
                  }}
                  testID={`minimap-strip-${item().id}`}
                >
                  <View
                    class="absolute inset-0 rounded-full transition-opacity duration-150"
                    style={{ backgroundColor: tokenAlpha("foreground", 0.55), opacity: highlighted() ? 1 : 0, pointerEvents: "none" }}
                    accessibilityLabel={highlighted() ? "In view" : undefined}
                  />
                </View>
              );
            }}
            </Each>
            {showCard() ? (
              <View
                ref={(node: ViewRef) => { cardNode = node; }}
                onLayout={(event) => { cardHeight.set(event.bounds.size.height); measureInto(cardNode ?? undefined, cardRect); }}
                onPress={() => {}}
                selectable
                class="absolute rounded-xl border p-3"
                style={{
                  left: CARD_LEFT,
                  width: CARD_WIDTH,
                  top: (timelineMinimapTopPercent(resolvedActive() ?? 0, count()) / 100) * railHeight() + timelineMinimapPreviewShift(resolvedActive() ?? 0, count(), cardHeight()),
                  backgroundColor: token("popover"),
                  borderColor: tokenAlpha("foreground", 0.1),
                }}
                testID="timeline-minimap-preview"
              >
                <Text class="truncate text-sm font-medium text-popover-foreground" style={{ lineHeight: 20 }}>{activeItem()!.userText ?? "User message"}</Text>
                {activeItem()!.assistantText ? <Text class="mt-1 line-clamp-3 text-sm text-muted-foreground" style={{ lineHeight: 20 }}>{activeItem()!.assistantText}</Text> : null}
              </View>
            ) : null}
            <NavigationButton direction="next" disabled={nextItem() === null} interactive={navigationInteractive()} railHeight={railHeight} onPress={() => { const item = nextItem(); if (item) props.onSelect(item); }} />
          </View>
        </View>
      ) : null}
    </>
  );
}
