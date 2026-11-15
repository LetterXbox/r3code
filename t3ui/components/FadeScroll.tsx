// ui/scroll-area.tsx `scrollFade`: the scrolled content fades out over 1.5rem at an edge that has more content beyond
// it, the fade growing with the overflow on that side. GPUI ignores CSS `maskImage` (Shimmer.tsx), so FadeScroll
// renders pointer-events-none edge gradient overlays painted in the container's reactive theme token.
import { colorScheme, Scroll, signal, token, untracked, View } from "nsh";
import type { ScrollRef } from "nsh";
import { parseColor } from "./composer/tokenColor";

export const SCROLL_FADE_SIZE = 24;

export type FadeSurfaceToken = Parameters<typeof token>[0];

type Size = { width: number; height: number };
type Report = { offset: { x: number; y: number }; contentSize: Size; size: Size };

/** The mask for a scroll position along `axis` (vertical by default), or undefined when nothing overflows that way. */
export function scrollFadeMask(report: Report | null, fade = SCROLL_FADE_SIZE, axis: "x" | "y" = "y"): string | undefined {
  if (!report) return undefined;
  const length = axis === "y" ? report.size.height : report.size.width;
  const content = axis === "y" ? report.contentSize.height : report.contentSize.width;
  const offset = axis === "y" ? report.offset.y : report.offset.x;
  if (length <= 0) return undefined;
  const start = Math.max(0, Math.min(fade, offset));
  const end = Math.max(0, Math.min(fade, content - length - offset));
  if (start === 0 && end === 0) return undefined;
  return `linear-gradient(to ${axis === "y" ? "bottom" : "right"}, transparent 0px, black ${start}px, black ${Math.max(start, length - end)}px, transparent ${length}px)`;
}

/** Overflow fade depths in points at the start and end edges along `axis`. */
export function scrollFadeAmounts(report: Report | null, fade = SCROLL_FADE_SIZE, axis: "x" | "y" = "y"): { start: number; end: number } {
  if (!report) return { start: 0, end: 0 };
  const length = axis === "y" ? report.size.height : report.size.width;
  const content = axis === "y" ? report.contentSize.height : report.contentSize.width;
  const offset = axis === "y" ? report.offset.y : report.offset.x;
  if (length <= 0 || content <= length) return { start: 0, end: 0 };
  const clamped = Math.max(0, Math.min(content - length, offset));
  return {
    start: Math.max(0, Math.min(fade, clamped)),
    end: Math.max(0, Math.min(fade, content - length - clamped)),
  };
}

/** Reads the current surface color reactively so theme/colorScheme changes repaint fade overlays immediately. */
export function resolveFadeColor(surface?: FadeSurfaceToken, fadeColor?: () => string): string {
  colorScheme();
  if (fadeColor) return fadeColor();
  const value = token(surface ?? "background");
  return typeof value === "string" && value.length > 0 && value !== "undefined" ? value : "";
}

/** Linear gradient fading from `rgba(r,g,b,0)` into `color` at the clipped/scrolled edge. */
export function fadeGradientStyle(edge: "top" | "bottom" | "left" | "right", color: string): { backgroundImage?: string } {
  if (!color || color === "undefined") return {};
  const rgb = parseColor(color);
  const clear = rgb ? `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)` : "transparent";
  const direction = edge === "top" ? "to top" : edge === "bottom" ? "to bottom" : edge === "left" ? "to left" : "to right";
  return { backgroundImage: `linear-gradient(${direction}, ${clear} 0px, ${color} 100%)` };
}

/** Pointer-transparent edge fade overlays for a Scroll or clipped container. */
export function ScrollFadeOverlays(props: {
  amounts: () => { start: number; end: number };
  horizontal?: boolean;
  surface?: FadeSurfaceToken;
  fadeColor?: () => string;
}) {
  const color = () => resolveFadeColor(props.surface, props.fadeColor);
  return (
    <>
      {props.amounts().start > 0 ? (
        <View
          class={props.horizontal ? "absolute inset-y-0 left-0" : "absolute inset-x-0 top-0"}
          style={{
            ...(props.horizontal ? { width: props.amounts().start } : { height: props.amounts().start }),
            ...fadeGradientStyle(props.horizontal ? "left" : "top", color()),
            pointerEvents: "none",
          }}
        />
      ) : null}
      {props.amounts().end > 0 ? (
        <View
          class={props.horizontal ? "absolute inset-y-0 right-0" : "absolute inset-x-0 bottom-0"}
          style={{
            ...(props.horizontal ? { width: props.amounts().end } : { height: props.amounts().end }),
            ...fadeGradientStyle(props.horizontal ? "right" : "bottom", color()),
            pointerEvents: "none",
          }}
        />
      ) : null}
    </>
  );
}

const CONTENT_LAYOUT_TOKEN = /^(?:grow|shrink|h-full|w-max|min-w-full|min-h-0)$/;
const SCROLL_BOUND_TOKEN = /^(?:max-h-|max-w-)/;
const OUTER_ONLY_TOKEN = /^(?:m[trblxy]?-|-m[trblxy]?-|border|rounded|bg-|shadow)/;

function splitFadeScrollClasses(className?: string, horizontal?: boolean) {
  const tokens = (className ?? "").split(/\s+/).filter(Boolean);
  const outer: string[] = [];
  const inner: string[] = [];
  let fillsVertical = false;
  for (const entry of tokens) {
    if (SCROLL_BOUND_TOKEN.test(entry)) {
      inner.push(entry);
      continue;
    }
    outer.push(entry);
    if (!OUTER_ONLY_TOKEN.test(entry)) {
      if (entry === "flex-1" || entry === "h-full" || /^h-\S+$/.test(entry)) fillsVertical = true;
      else inner.push(entry);
    }
  }
  if (fillsVertical) inner.push("min-h-0", "flex-1");
  if (horizontal && !inner.includes("min-w-0") && outer.includes("min-w-0")) inner.push("min-w-0");
  return {
    outerClass: ["relative", "overflow-hidden", ...outer].join(" "),
    scrollClass: inner.join(" ") || undefined,
  };
}

function splitContentClass(contentClass?: string, horizontal?: boolean): { scrollContentClass?: string; viewClass?: string } {
  const tokens = (contentClass ?? "").split(/\s+/).filter(Boolean);
  const sizing = tokens.filter((entry) => CONTENT_LAYOUT_TOKEN.test(entry));
  if (horizontal) {
    if (!sizing.includes("w-max")) sizing.push("w-max");
    if (!sizing.includes("min-w-full")) sizing.push("min-w-full");
  }
  return {
    scrollContentClass: sizing.length > 0 ? sizing.join(" ") : undefined,
    viewClass: contentClass || undefined,
  };
}

export function FadeScroll(props: {
  class?: string;
  contentClass?: string;
  style?: Record<string, unknown>;
  fade?: boolean;
  horizontal?: boolean;
  surface?: FadeSurfaceToken;
  fadeColor?: () => string;
  scrollbar?: any;
  scrollEventThrottle?: number;
  role?: any;
  accessibilityLabel?: string;
  desktop?: any;
  children?: any;
  testID?: string;
  ref?: (node: ScrollRef | null) => void;
  onScroll?: (event: Report) => void;
  onLayout?: (event: { bounds: { size: Size } }) => void;
  onContentLayout?: (size: Size) => void;
}) {
  const offset = signal({ x: 0, y: 0 });
  const viewport = signal<Size>({ width: 0, height: 0 });
  const content = signal<Size>({ width: 0, height: 0 });
  const classes = () => splitFadeScrollClasses(props.class, props.horizontal);
  const contentClasses = () => splitContentClass(props.contentClass, props.horizontal);
  const outerStyle = () => {
    if (!props.style) return undefined;
    const { maxHeight: _mh, maxWidth: _mw, ...rest } = props.style;
    return Object.keys(rest).length > 0 ? rest : undefined;
  };
  const scrollStyle = () => {
    if (!props.style) return undefined;
    const next: Record<string, unknown> = {};
    if (props.style.maxHeight !== undefined) next.maxHeight = props.style.maxHeight;
    if (props.style.maxWidth !== undefined) next.maxWidth = props.style.maxWidth;
    return Object.keys(next).length > 0 ? next : undefined;
  };
  const amounts = () => {
    if (props.fade === false) return { start: 0, end: 0 };
    return scrollFadeAmounts({ offset: offset(), contentSize: content(), size: viewport() }, SCROLL_FADE_SIZE, props.horizontal ? "x" : "y");
  };
  const syncOffset = (next: { x?: number; y?: number }) => {
    untracked(() => {
      const prev = offset();
      const maxX = Math.max(0, content().width - viewport().width);
      const maxY = Math.max(0, content().height - viewport().height);
      const x = next.x !== undefined ? Math.max(0, Math.min(maxX, next.x)) : prev.x;
      const y = next.y !== undefined ? Math.max(0, Math.min(maxY, next.y)) : prev.y;
      if (x !== prev.x || y !== prev.y) offset.set({ x, y });
    });
  };
  let wrappedNode: ScrollRef | null = null;
  const wrapRef = (node: ScrollRef | null) => {
    if (!props.ref) return;
    if (!node) {
      wrappedNode = null;
      props.ref(null);
      return;
    }
    if (node !== wrappedNode) {
      wrappedNode = node;
      const origScrollTo = node.scrollTo.bind(node);
      const origScrollToEnd = node.scrollToEnd.bind(node);
      try {
        node.scrollTo = (target: { x?: number; y?: number; animated?: boolean }) => {
          syncOffset(target);
          origScrollTo(target);
        };
        node.scrollToEnd = (options?: { animated?: boolean }) => {
          untracked(() => {
            syncOffset(props.horizontal ? { x: Math.max(0, content().width - viewport().width) } : { y: Math.max(0, content().height - viewport().height) });
          });
          origScrollToEnd(options);
        };
      } catch {
        // Keep native ScrollRef intact if scroll methods are non-writable so native methods like measure() continue working.
      }
    }
    props.ref(node);
  };
  return (
    <View class={classes().outerClass} style={outerStyle() as never}>
      <Scroll
        ref={props.ref ? wrapRef : undefined}
        class={classes().scrollClass}
        horizontal={props.horizontal}
        scrollbar={props.scrollbar}
        scrollEventThrottle={props.scrollEventThrottle}
        role={props.role}
        accessibilityLabel={props.accessibilityLabel}
        desktop={props.desktop}
        contentClass={contentClasses().scrollContentClass}
        testID={props.testID}
        style={scrollStyle() as never}
        onLayout={(event) => {
          viewport.set(event.bounds.size);
          props.onLayout?.(event);
        }}
        onScroll={(event: Report) => {
          offset.set(event.offset);
          content.set(event.contentSize);
          viewport.set(event.size);
          props.onScroll?.(event);
        }}
      >
        <View
          class={contentClasses().viewClass}
          onLayout={(event) => {
            content.set(event.bounds.size);
            props.onContentLayout?.(event.bounds.size);
          }}
        >
          {props.children}
        </View>
      </Scroll>
      <ScrollFadeOverlays amounts={amounts} horizontal={props.horizontal} surface={props.surface} fadeColor={props.fadeColor} />
    </View>
  );
}
