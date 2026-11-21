import { expect, test } from "nsh/test";
import type { Surface } from "./panelLogic";
import { keepsPage, keptSurfaceKey, nextKeptSurfaces, type KeptSurface } from "./persistentSurfaces";

const browser: Surface = { id: "browser:1", kind: "preview", previewUrl: "http://localhost:3000/" };
const terminal: Surface = { id: "terminal:term-1", kind: "terminal", terminalIds: ["term-1"], activeTerminalId: "term-1" };
const files: Surface = { id: "files", kind: "files" };
const panel = (name: string, surfaces: Surface[]) => ({ panelKey: `panel-${name}`, threadId: `thread-${name}`, cwd: "/project", surfaces });
const everything = () => true;

test("only browser and terminal tabs keep their page", () => {
  expect(["preview", "terminal", "files", "diff", "file", "side-chat", "device", "pull-request", "pull-requests", "issue"].filter((kind) => keepsPage(kind as Surface["kind"]))).toEqual(["preview", "terminal"]);
});

test("the open thread's page tabs are kept, and an unchanged panel returns the same list and entries", () => {
  const first = nextKeptSurfaces([], panel("a", [browser, files, terminal]), everything);
  expect(first.map((entry) => entry.id)).toEqual(["browser:1", "terminal:term-1"]);
  // A new address, a width commit or a new active tab is a new surface object with the same id: the entry stays.
  const again = nextKeptSurfaces(first, panel("a", [{ ...browser, previewUrl: "http://localhost:3000/next" }, files, terminal]), everything);
  expect(again).toBe(first);
});

test("a closed tab is dropped; the others keep their entries", () => {
  const first = nextKeptSurfaces([], panel("a", [browser, terminal]), everything);
  const next = nextKeptSurfaces(first, panel("a", [terminal]), everything);
  expect(next.map((entry) => entry.id)).toEqual(["terminal:term-1"]);
  expect(next[0]).toBe(first[1]);
});

test("another thread's tabs stay while it is not the open one, under their own key", () => {
  const a = nextKeptSurfaces([], panel("a", [browser]), everything);
  const both = nextKeptSurfaces(a, panel("b", [browser]), everything);
  expect(both.map(keptSurfaceKey)).toEqual(["panel-a\nbrowser:1", "panel-b\nbrowser:1"]);
  expect(both[0]).toBe(a[0]);
  // Back on thread a: its entry is the one made first (the page was never made again), now the most recent.
  const back = nextKeptSurfaces(both, panel("a", [browser]), everything);
  expect(back.map((entry) => entry.panelKey)).toEqual(["panel-b", "panel-a"]);
  expect(back[1]).toBe(a[0]);
});

test("no open panel keeps the list; a tab closed in a thread that is not open is dropped", () => {
  const a = nextKeptSurfaces([], panel("a", [browser, terminal]), everything);
  expect(nextKeptSurfaces(a, null, everything)).toBe(a);
  const pruned = nextKeptSurfaces(a, null, (_panelKey, id) => id !== "browser:1");
  expect(pruned.map((entry) => entry.id)).toEqual(["terminal:term-1"]);
});

test("the oldest threads beyond the cap give their pages up", () => {
  let kept: readonly KeptSurface[] = [];
  for (const name of ["a", "b", "c"]) kept = nextKeptSurfaces(kept, panel(name, [browser, terminal]), everything, 2);
  expect([...new Set(kept.map((entry) => entry.panelKey))]).toEqual(["panel-b", "panel-c"]);
  expect(kept.length).toBe(4);
});

test("a thread whose folder changed gets new entries (its terminals open in the new folder)", () => {
  const first = nextKeptSurfaces([], panel("a", [terminal]), everything);
  const moved = nextKeptSurfaces(first, { ...panel("a", [terminal]), cwd: "/elsewhere" }, everything);
  expect(moved[0]).not.toBe(first[0]);
  expect(moved[0]?.cwd).toBe("/elsewhere");
});
