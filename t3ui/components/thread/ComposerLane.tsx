import { View, windowSize } from "nsh";
import { chatLaneInset } from "./chatLane";
import { chatWidthClass } from "./layout";

/**
 * The reference's composer lane: the chat lane's inset each side, then the composer stack centred at the
 * chat width, so its card shares the transcript's left and right edges. `pb-1` plus the composer's own pb-3 is
 * the 16pt the reference leaves under the card.
 */
export function ComposerLane(props: { area: () => number; children?: any; onLaneWidth?: (width: number) => void; bottomGap?: () => boolean; onHeight?: (height: number) => void }) {
  // The draft layout centres the composer, so it drops the window-bottom gap (bottomGap false).
  return (
    <View class={props.bottomGap?.() === false ? "shrink-0" : "shrink-0 pb-1"} onLayout={props.onHeight ? (event) => props.onHeight?.(event.bounds.size.height) : undefined} style={{ paddingLeft: chatLaneInset(windowSize().width), paddingRight: chatLaneInset(windowSize().width) }}>
      <View class={`mx-auto w-full ${chatWidthClass()}`} onLayout={props.onLaneWidth ? (event) => props.onLaneWidth?.(event.bounds.size.width) : undefined}>
        {props.children}
      </View>
    </View>
  );
}
