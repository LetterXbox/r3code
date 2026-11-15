// The quit shortcut's confirmation, on a fake clock: direct quits at once, double-click needs two presses, hold needs the key held for 1.2 s or two presses.
import { expect, test } from "nsh/test";
import { createQuitController, HOLD_HINT_LINGER_MS, quitHintMessage, QUIT_DOUBLE_PRESS_MS, QUIT_HOLD_DURATION_MS, type QuitClock, type QuitMode } from "./quitHold";

function fixture(mode: QuitMode) {
  let time = 1000;
  let nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: QuitClock = {
    now: () => time,
    setTimer: (run, ms) => { const id = ++nextId; timers.set(id, { at: time + ms, run }); return id; },
    clearTimer: (handle) => { timers.delete(handle as number); },
  };
  let quits = 0;
  const controller = createQuitController({ mode: () => mode, quit: () => { quits += 1; }, clock });
  const advance = (ms: number) => {
    time += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.run(); }
  };
  return { controller, advance, quits: () => quits };
}

test("direct quits on the first press and shows nothing", () => {
  const { controller, quits } = fixture("direct");
  controller.press();
  expect(quits()).toBe(1);
  expect(controller.hint()).toBe(null);
});

test("double-click: the first press shows the hint for half a second, a second press inside it quits", () => {
  const { controller, advance, quits } = fixture("double-click");
  controller.press();
  expect(controller.hint()).toBe("double-click");
  expect(quits()).toBe(0);
  advance(300);
  controller.press();
  expect(quits()).toBe(1);
  expect(controller.hint()).toBe(null);
});

test("double-click: a second press after the window starts over", () => {
  const { controller, advance, quits } = fixture("double-click");
  controller.press();
  advance(QUIT_DOUBLE_PRESS_MS + 50);
  expect(controller.hint()).toBe(null);
  controller.press();
  expect(quits()).toBe(0);
  expect(controller.hint()).toBe("double-click");
});

test("hold: the hint shows, auto-repeats keep it, and the key held for 1.2 s quits", () => {
  const { controller, advance, quits } = fixture("hold");
  controller.press();
  expect(controller.hint()).toBe("hold");
  // Auto-repeat: quick successive activations.
  for (let elapsed = 0; elapsed < QUIT_HOLD_DURATION_MS - 100; elapsed += 100) { advance(100); controller.press(); }
  expect(quits()).toBe(0);
  expect(controller.hint()).toBe("hold");
  advance(100);
  controller.press();
  expect(quits()).toBe(1);
});

test("hold: letting go early hides the hint after a moment and nothing quits; two presses by hand quit", () => {
  const { controller, advance, quits } = fixture("hold");
  controller.press();
  advance(HOLD_HINT_LINGER_MS + 10);
  expect(controller.hint()).toBe(null);
  expect(quits()).toBe(0);
  controller.press();
  advance(400);
  controller.press();
  expect(quits()).toBe(1);
});

test("the hint copy names the shortcut", () => {
  expect(quitHintMessage("hold")).toMatch(/^Hold .*Q or press twice to quit$/);
  expect(quitHintMessage("double-click")).toMatch(/^Press .*Q again to quit$/);
});
