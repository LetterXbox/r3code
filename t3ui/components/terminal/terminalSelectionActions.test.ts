import { expect, test } from "nsh/test";
import { createSelectionActions, SELECTION_MULTI_CLICK_INTERVAL_MS, type SelectionActionPoint } from "./terminalSelectionActions";

// A scheduler the test runs by hand: timers and animation frames wait in a list until `flush`.
function harness() {
  const queue: { id: number; run: () => void; delay: number; frame: boolean }[] = [];
  let next = 0;
  const shown: (SelectionActionPoint | null)[] = [];
  const dismissed: string[] = [];
  const selection = createSelectionActions({
    scheduler: {
      setTimeout: (run, delay) => { queue.push({ id: ++next, run, delay, frame: false }); return next; },
      clearTimeout: (handle) => { const at = queue.findIndex((item) => item.id === handle); if (at >= 0) queue.splice(at, 1); },
      requestAnimationFrame: (run) => { queue.push({ id: ++next, run, delay: 0, frame: true }); return next; },
      cancelAnimationFrame: (handle) => { const at = queue.findIndex((item) => item.id === handle); if (at >= 0) queue.splice(at, 1); },
    },
    onSelection: (pointer) => shown.push(pointer),
    onDismiss: (reason) => dismissed.push(reason),
  });
  const flush = () => { while (queue.length > 0) queue.shift()!.run(); };
  const select = (detail = 1) => {
    selection.pointerDown({ isPrimary: true, button: 0, inside: true });
    selection.selectionStart({ isPrimary: true, button: 0, defaultPrevented: false, onButton: false });
    selection.pointerUp({ isPrimary: true, button: 0 });
    selection.mouseUp({ button: 0, detail, x: 30, y: 40 });
  };
  return { selection, queue, shown, dismissed, flush, select };
}

test("finishing a mouse selection offers the menu at the pointer, after a frame", () => {
  const { queue, shown, flush, select } = harness();
  select();
  expect(shown).toEqual([]);
  expect(queue.length).toBe(1);
  flush();
  expect(shown).toEqual([{ x: 30, y: 40 }]);
});

test("a double click waits for the next click of the multi-click window before offering the menu", () => {
  const { queue, shown, flush, select } = harness();
  select(2);
  expect(queue[0]?.delay).toBe(SELECTION_MULTI_CLICK_INTERVAL_MS);
  flush();
  expect(shown.length).toBe(1);
});

test("a press, a key, Escape or the context menu cancels a pending menu", () => {
  const pressed = harness();
  pressed.select();
  pressed.selection.pointerDown({ isPrimary: true, button: 0, inside: true });
  pressed.flush();
  expect(pressed.shown).toEqual([]);
  expect(pressed.dismissed).toEqual(["interaction", "interaction"]);

  const typed = harness();
  typed.select();
  typed.selection.keyDown("a");
  typed.flush();
  expect(typed.shown).toEqual([]);

  const escaped = harness();
  escaped.select();
  escaped.selection.keyDown("Escape");
  escaped.flush();
  expect(escaped.shown).toEqual([]);
  expect(escaped.dismissed).toEqual(["interaction", "cancel"]);

  const menu = harness();
  menu.select();
  menu.selection.contextMenu();
  menu.flush();
  expect(menu.shown).toEqual([]);
});

test("only a primary press on the terminal itself starts a gesture: buttons, other pointers and prevented presses do not", () => {
  const { shown, flush, selection } = harness();
  selection.pointerDown({ isPrimary: true, button: 0, inside: true });
  selection.selectionStart({ isPrimary: true, button: 0, defaultPrevented: false, onButton: true });
  selection.mouseUp({ button: 0, detail: 1, x: 1, y: 1 });
  selection.pointerDown({ isPrimary: true, button: 0, inside: true });
  selection.selectionStart({ isPrimary: true, button: 0, defaultPrevented: true, onButton: false });
  selection.mouseUp({ button: 0, detail: 1, x: 1, y: 1 });
  selection.pointerDown({ isPrimary: false, button: 0, inside: true });
  selection.selectionStart({ isPrimary: false, button: 0, defaultPrevented: false, onButton: false });
  selection.mouseUp({ button: 0, detail: 1, x: 1, y: 1 });
  selection.pointerDown({ isPrimary: true, button: 2, inside: true });
  selection.selectionStart({ isPrimary: true, button: 2, defaultPrevented: false, onButton: false });
  selection.mouseUp({ button: 2, detail: 1, x: 1, y: 1 });
  flush();
  expect(shown).toEqual([]);
});
