import { expect, test } from "nsh/test";
import { createTimelineWheelForwarder, createTimelineWheelGesture, MOUSE_WHEEL_SCROLL_MS } from "./timelineMinimapWheel";

test("a forwarded ladder wheel interrupts restoration and enters reader scrolling until stopped", () => {
  const events: string[] = [];
  const gesture = createTimelineWheelGesture({
    wheel: () => { events.push("wheel"); return true; },
    stop: () => events.push("stop"),
    cancelRestore: () => events.push("cancel restore"),
    follow: {
      beginUserScroll: () => events.push("begin"),
      navigate: ({ direction }) => events.push(direction),
      endUserScroll: () => events.push("end"),
    },
  });
  expect(gesture.wheel({ deltaY: -20, precise: true, ctrl: true })).toBe(false);
  expect(events).toEqual([]);
  expect(gesture.wheel({ deltaY: -20, precise: true, ctrl: false })).toBe(true);
  expect(events).toEqual(["cancel restore", "begin", "up", "wheel"]);
  gesture.stop();
  expect(events).toEqual(["cancel restore", "begin", "up", "wheel", "stop", "end"]);
  gesture.stop();
  expect(events.slice(-1)).toEqual(["stop"]);
});

function harness(reduced = false) {
  let offset = 500;
  let time = 0;
  let frames: Array<{ id: number; cb: (t: number) => void }> = [];
  let next = 1;
  const forwarder = createTimelineWheelForwarder({
    offset: () => offset,
    maxOffset: () => 2000,
    scrollTo: (to) => { offset = to; },
    now: () => time,
    requestFrame: (cb) => { const id = next++; frames.push({ id, cb }); return id; },
    cancelFrame: (id) => { frames = frames.filter((frame) => frame.id !== id); },
    reducedMotion: () => reduced,
  });
  const tick = (ms: number) => { time += ms; const due = frames; frames = []; for (const frame of due) frame.cb(time); };
  return { forwarder, tick, offset: () => offset, pending: () => frames.length };
}

test("a mouse wheel notch glides the transcript over 150 ms; a second notch adds to where the glide was headed", () => {
  const h = harness();
  expect(h.forwarder.wheel({ deltaY: 100, precise: false, ctrl: false })).toBe(true);
  h.tick(MOUSE_WHEEL_SCROLL_MS / 2);
  expect(h.offset() > 500 && h.offset() < 600).toBe(true);
  h.forwarder.wheel({ deltaY: 100, precise: false, ctrl: false });
  for (let i = 0; i < 20; i += 1) h.tick(16);
  expect(h.offset()).toBe(700);
  expect(h.pending()).toBe(0);
});

test("touchpads and reduced motion scroll at once; Ctrl + wheel and sideways wheels are left alone", () => {
  const h = harness();
  h.forwarder.wheel({ deltaY: 40, precise: true, ctrl: false });
  expect(h.offset()).toBe(540);
  expect(h.forwarder.wheel({ deltaY: 40, precise: false, ctrl: true })).toBe(false);
  expect(h.forwarder.wheel({ deltaY: 0, precise: false, ctrl: false })).toBe(false);
  const r = harness(true);
  r.forwarder.wheel({ deltaY: -9999, precise: false, ctrl: false });
  expect(r.offset()).toBe(0);
});

test("precise wheel bursts accumulate before asynchronous scroll metrics arrive", () => {
  let observed = 500;
  let now = 0;
  const writes: number[] = [];
  const forwarder = createTimelineWheelForwarder({
    offset: () => observed, maxOffset: () => 2000, scrollTo: (offset) => writes.push(offset),
    now: () => now, requestFrame: () => 1, cancelFrame: () => {}, reducedMotion: () => false,
  });
  forwarder.wheel({ deltaY: 20, precise: true, ctrl: false });
  forwarder.wheel({ deltaY: 15, precise: true, ctrl: false });
  expect(writes).toEqual([520, 535]);
  observed = 520; // The first write arrived; the second is still pending.
  forwarder.wheel({ deltaY: 10, precise: true, ctrl: false });
  expect(writes[2]).toBe(545);
  observed = 535;
  forwarder.wheel({ deltaY: 5, precise: true, ctrl: false });
  expect(writes[3]).toBe(550);
  now = 300;
  forwarder.wheel({ deltaY: 5, precise: true, ctrl: false });
  expect(writes[4]).toBe(540);
});

test("late metrics from before a direction reversal do not undo the latest scroll", () => {
  let observed = 500;
  const writes: number[] = [];
  const forwarder = createTimelineWheelForwarder({
    offset: () => observed, maxOffset: () => 2000, scrollTo: (offset) => writes.push(offset),
    now: () => 0, requestFrame: () => 1, cancelFrame: () => {}, reducedMotion: () => false,
  });
  forwarder.wheel({ deltaY: 30, precise: true, ctrl: false });
  forwarder.wheel({ deltaY: -20, precise: true, ctrl: false });
  observed = 530; // An older write arrives after the reversal.
  forwarder.wheel({ deltaY: -5, precise: true, ctrl: false });
  expect(writes).toEqual([530, 510, 505]);
});
