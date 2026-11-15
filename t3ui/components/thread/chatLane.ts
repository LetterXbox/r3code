import { signal } from "nsh";
// The reference's chat lane (ChatCanvas + index.css): the transcript and the composer share one lane that is
// centred in the chat area, `--chat-content-max-width` wide (46rem comfortable, 72rem wide, the whole area
// for full) with a 3rem inset each side from 640px up and 0.75rem below it.
export type ChatWidth = "comfortable" | "wide" | "full";

export const CHAT_LANE_MAX_WIDTH: Record<ChatWidth, number> = { comfortable: 736, wide: 1152, full: Infinity };
export const CHAT_LANE_WIDE_INSET = 48;
export const CHAT_LANE_NARROW_INSET = 12;
export const CHAT_LANE_INSET_BREAKPOINT = 640;

export function chatWidthSetting(value: unknown): ChatWidth {
  return value === "wide" || value === "full" ? value : "comfortable";
}

// The breakpoint is the reference's `@media (min-width: 640px)`: the WINDOW width, not the chat area's.
export function chatLaneInset(viewportWidth: number): number {
  return viewportWidth >= CHAT_LANE_INSET_BREAKPOINT ? CHAT_LANE_WIDE_INSET : CHAT_LANE_NARROW_INSET;
}

/** The width of the transcript and composer column inside a chat area `containerWidth` wide. */
export function chatLaneWidth(containerWidth: number, width: ChatWidth, viewportWidth = containerWidth): number {
  const inset = chatLaneInset(viewportWidth);
  return Math.max(0, Math.min(CHAT_LANE_MAX_WIDTH[width], containerWidth - inset * 2));
}

/** Distance from the timeline edge to the centered message column. */
export function chatLaneLeft(containerWidth: number, inset: number, width: ChatWidth): number {
  const inner = Math.max(0, containerWidth - inset * 2);
  return inset + Math.max(0, (inner - Math.min(inner, CHAT_LANE_MAX_WIDTH[width])) / 2);
}

// The reference's inline (docked) thread details card (threadDetailsCardLayout.ts + chatCanvasLayout.ts): when
// the chat canvas leaves `minChatWidth` (40rem) beside a 280pt card, the card sits 12pt in from the canvas's top
// and right edges and the chat lane ends 32pt (DETAILS_CARD_CLEARANCE) left of it; otherwise it is a popover.
export const THREAD_DETAILS_CARD_WIDTH = 280;
export const THREAD_DETAILS_CARD_GAP = 12;
export const DETAILS_CARD_CLEARANCE = 32;
const CHAT_MIN_WIDTH = 640;

/** The chat canvas's size (below the header), reported by ThreadView. */
export const chatCanvasSize = signal({ width: 0, height: 0 });

export function threadDetailsDocks(canvas: { width: number; height: number }, viewportWidth: number): boolean {
  const padding = chatLaneInset(viewportWidth);
  const x = canvas.width - THREAD_DETAILS_CARD_WIDTH - THREAD_DETAILS_CARD_GAP;
  if (x - DETAILS_CARD_CLEARANCE - padding < CHAT_MIN_WIDTH) return false;
  return canvas.height - THREAD_DETAILS_CARD_GAP * 2 >= 160;
}

/** The extra right inset the lane takes while the card is docked (resolveChatCanvasLayout's insetEnd). */
export function dockedDetailsInsetEnd(canvasWidth: number, viewportWidth: number, width: ChatWidth): number {
  const padding = chatLaneInset(viewportWidth);
  const centered = Math.max(0, Math.min(CHAT_LANE_MAX_WIDTH[width], canvasWidth - padding * 2));
  const laneRight = canvasWidth - THREAD_DETAILS_CARD_WIDTH - THREAD_DETAILS_CARD_GAP - DETAILS_CARD_CLEARANCE;
  const laneWidth = Math.max(0, Math.min(centered, laneRight - padding));
  const left = Math.max(padding, Math.min((canvasWidth - laneWidth) / 2, laneRight - laneWidth));
  return Math.max(0, canvasWidth - left * 2 - laneWidth);
}
