import { expect, test } from "nsh/test";
import { clampGrid, createPostOnce, createResizeGate, createScreenBuffer, createSnapshotGate, type Grid, type Scheduler } from "./terminalMessages";
import { MAX_PERSISTENT_DRAWERS, drawerShown, nextMountedDrawers, type DrawerTarget } from "./persistentDrawers";

test("font and theme messages go out only when their value changed, and again after a page reload", () => {
  const sent: string[] = [];
  const post = createPostOnce((payload) => sent.push(payload));
  expect(post.send("theme", "a")).toBe(true);
  expect(post.send("theme", "a")).toBe(false);
  expect(post.send("font", "a")).toBe(true);
  expect(post.send("theme", "b")).toBe(true);
  expect(post.send("theme", "b")).toBe(false);
  post.forget();
  expect(post.send("theme", "b")).toBe(true);
  expect(sent).toEqual(["a", "a", "b", "b"]);
});

function manualScheduler() {
  const queue: { run: () => void; live: boolean }[] = [];
  const schedule: Scheduler = (run) => { const item = { run, live: true }; queue.push(item); return () => { item.live = false; }; };
  return { schedule, flush() { for (const item of queue.splice(0)) if (item.live) item.run(); }, pending: () => queue.filter((item) => item.live).length };
}

test("a burst of resize reports sends one resize, and an unchanged grid sends none", () => {
  const sent: Grid[] = [];
  const timers = manualScheduler();
  const gate = createResizeGate((grid) => sent.push(grid), 100, timers.schedule);
  gate.request({ cols: 80, rows: 24 });
  gate.request({ cols: 90, rows: 24 });
  gate.request({ cols: 100, rows: 30 });
  expect(timers.pending()).toBe(1);
  timers.flush();
  expect(sent).toEqual([{ cols: 100, rows: 30 }]);
  // Layout passes report the same size again: nothing is scheduled or sent.
  gate.request({ cols: 100, rows: 30 });
  expect(timers.pending()).toBe(0);
  // A burst that ends where it started is also silent.
  gate.request({ cols: 101, rows: 30 });
  gate.request({ cols: 100, rows: 30 });
  timers.flush();
  expect(sent.length).toBe(1);
  // A new attach forgets what the server knows, so the grid is sent once more.
  gate.forget();
  gate.request({ cols: 100, rows: 30 });
  timers.flush();
  expect(sent.length).toBe(2);
  gate.request({ cols: 120, rows: 30 });
  gate.cancel();
  timers.flush();
  expect(sent.length).toBe(2);
});

test("grids are clamped to what the server accepts and rejected when not numbers", () => {
  expect(clampGrid(80.9, 24.2)).toEqual({ cols: 80, rows: 24 });
  expect(clampGrid(0, 9999)).toEqual({ cols: 1, rows: 500 });
  expect(clampGrid("80", 24)).toBeNull();
  expect(clampGrid(Number.NaN, 24)).toBeNull();
});

test("a repeated snapshot of what is already painted does not reset the canvas", () => {
  const gate = createSnapshotGate();
  expect(gate.accept("history")).toBe(true);
  expect(gate.accept("history")).toBe(false);
  gate.invalidate();
  expect(gate.accept("history")).toBe(true);
  expect(gate.accept("history plus")).toBe(true);
});

const target = (key: string): DrawerTarget => ({ key, threadId: key, cwd: `/work/${key}` });

test("visited thread drawers stay mounted, most recent last, capped, and only the open one is shown", () => {
  let mounted: readonly DrawerTarget[] = [];
  mounted = nextMountedDrawers(mounted, target("a"));
  mounted = nextMountedDrawers(mounted, target("b"));
  expect(mounted.map((item) => item.key)).toEqual(["a", "b"]);
  const before = mounted;
  expect(nextMountedDrawers(mounted, target("b"))).toBe(before);
  // Switching back keeps thread a's entry (same object: its drawer is not remounted) and a null current changes nothing.
  const first = mounted[0]!;
  mounted = nextMountedDrawers(mounted, target("a"));
  expect(mounted.map((item) => item.key)).toEqual(["b", "a"]);
  expect(mounted[1]).toBe(first);
  expect(nextMountedDrawers(mounted, null)).toBe(mounted);
  for (let index = 0; index < MAX_PERSISTENT_DRAWERS + 3; index++) mounted = nextMountedDrawers(mounted, target(`t${index}`));
  expect(mounted.length).toBe(MAX_PERSISTENT_DRAWERS);
  expect(mounted[mounted.length - 1]!.key).toBe(`t${MAX_PERSISTENT_DRAWERS + 2}`);
  expect(drawerShown("a", target("a"), false)).toBe(true);
  expect(drawerShown("a", target("b"), false)).toBe(false);
  expect(drawerShown("a", target("a"), true)).toBe(false);
  expect(drawerShown("a", null, false)).toBe(false);
});

test("the screen buffer keeps the snapshot and the output since, so a reloaded page repaints all of it", () => {
  const screen = createScreenBuffer(32);
  screen.note({ type: "reset", data: "$ ls\r\na.txt\r\n" });
  screen.note({ type: "output", data: "$ " });
  expect(screen.text()).toBe("$ ls\r\na.txt\r\n$ ");
  screen.note({ type: "reset", data: "" });
  expect(screen.text()).toBe("");
  screen.note({ type: "output", data: "line-one-xxxxxxxx\nline-two-xxxxxxxx\nline-3\n" });
  expect(screen.text()).toBe("line-two-xxxxxxxx\nline-3\n");
  screen.clear();
  expect(screen.text()).toBe("");
});
