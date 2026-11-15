// timelineMinimapWheel.ts: a wheel over the minimap rail scrolls the transcript. Mouse wheel notches glide there over 150 ms
// (ease-out cubic), each new notch adding to where the running glide was headed; touchpads and high-resolution wheels, and
// reduced motion, scroll at once. Ctrl + wheel (zoom) and sideways-only wheels are left alone.

export const MOUSE_WHEEL_SCROLL_MS = 150;
const PRECISE_INPUT_IDLE_MS = 150;

export interface WheelScrollIo {
  /** The transcript's offset now. */
  readonly offset: () => number;
  /** Its largest offset (content less viewport). */
  readonly maxOffset: () => number;
  readonly scrollTo: (offset: number) => void;
  readonly now: () => number;
  readonly requestFrame: (callback: (time: number) => void) => number;
  readonly cancelFrame: (frame: number) => void;
  readonly reducedMotion: () => boolean;
}

export interface WheelInput {
  readonly deltaY: number;
  readonly precise: boolean;
  readonly ctrl: boolean;
}

/** A forwarded wheel is a reader gesture even though the native list never receives the wheel itself. */
export function createTimelineWheelGesture(io: {
  wheel: (event: WheelInput) => boolean;
  stop: () => void;
  cancelRestore: () => void;
  follow: { beginUserScroll: () => void; navigate: (event: { source: "wheel"; direction: "up" | "down" }) => void; endUserScroll: () => void };
}) {
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  return {
    wheel(event: WheelInput): boolean {
      if (event.ctrl || event.deltaY === 0) return false;
      io.cancelRestore();
      active = true;
      io.follow.beginUserScroll();
      io.follow.navigate({ source: "wheel", direction: event.deltaY < 0 ? "up" : "down" });
      const handled = io.wheel(event);
      clearTimeout(endTimer);
      // A mouse-wheel glide lasts 150 ms; its scroll reports must remain part of the gesture.
      endTimer = setTimeout(() => { endTimer = undefined; active = false; io.follow.endUserScroll(); }, MOUSE_WHEEL_SCROLL_MS);
      return handled;
    },
    stop() {
      clearTimeout(endTimer);
      endTimer = undefined;
      io.stop();
      if (active) io.follow.endUserScroll();
      active = false;
    },
  };
}

export function createTimelineWheelForwarder(io: WheelScrollIo) {
  let glide: { from: number; to: number; start: number; written: number; frame: number } | null = null;
  let precise: { min: number; max: number; target: number; at: number } | null = null;
  const stop = () => {
    if (!glide) return null;
    const current = glide;
    io.cancelFrame(current.frame);
    glide = null;
    return current;
  };
  const clamp = (offset: number) => Math.max(0, Math.min(io.maxOffset(), offset));
  const glideBy = (distance: number) => {
    const current = stop();
    const top = io.offset();
    const base = current ? current.to + top - current.written : top;
    const next = { from: top, to: clamp(base + distance), start: io.now(), written: top, frame: 0 };
    const step = (time: number) => {
      if (glide !== next) return;
      // The transcript moved by itself meanwhile (streaming, its own scroll): carry the glide along.
      const drift = io.offset() - next.written;
      next.from += drift;
      next.to += drift;
      const progress = Math.min(1, Math.max(0, (time - next.start) / MOUSE_WHEEL_SCROLL_MS));
      const at = next.from + (next.to - next.from) * (1 - (1 - progress) ** 3);
      io.scrollTo(at);
      next.written = at;
      if (progress < 1) next.frame = io.requestFrame(step);
      else glide = null;
    };
    next.frame = io.requestFrame(step);
    glide = next;
  };
  return {
    /** forwardWheelToTimeline: true when the wheel scrolled the transcript. */
    wheel(event: WheelInput): boolean {
      if (event.ctrl || event.deltaY === 0) return false;
      if (event.precise || io.reducedMotion()) {
        stop();
        const actual = io.offset();
        const now = io.now();
        // Scroll notifications may report an earlier write after a later one
        // has already been queued. Keep the target while metrics catch up.
        const catchingUp = precise && now - precise.at < PRECISE_INPUT_IDLE_MS
          && actual >= precise.min - 0.5 && actual <= precise.max + 0.5;
        const base = catchingUp && precise ? precise.target : actual;
        const target = clamp(base + event.deltaY);
        precise = {
          min: Math.min(actual, target, catchingUp && precise ? precise.min : actual),
          max: Math.max(actual, target, catchingUp && precise ? precise.max : actual),
          target, at: now,
        };
        io.scrollTo(target);
        return true;
      }
      precise = null;
      glideBy(event.deltaY);
      return true;
    },
    /** A press or key interrupts a glide (glideBy's pointerdown / keydown listeners). */
    stop: () => { precise = null; stop(); },
  };
}
