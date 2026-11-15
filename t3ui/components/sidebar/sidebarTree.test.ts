import { expect, test } from "nsh/test";
import { nextTreeMove } from "./sidebarTree";
import type { TreeRow } from "./sidebarTree";

const rows: TreeRow[] = [
  { id: "thread:loose", parent: null, expanded: null },
  { id: "project:a", parent: null, expanded: true },
  { id: "thread:a1", parent: "project:a", expanded: null },
  { id: "thread:a2", parent: "project:a", expanded: null },
  { id: "project:b", parent: null, expanded: false },
  { id: "shelf:settled", parent: null, expanded: true },
  { id: "thread:s1", parent: "shelf:settled", expanded: null },
];

test("down and up step between rows and stop at the ends", () => {
  expect(nextTreeMove(rows, "thread:loose", "down")).toEqual({ focus: "project:a" });
  expect(nextTreeMove(rows, "thread:a1", "up")).toEqual({ focus: "project:a" });
  expect(nextTreeMove(rows, "thread:s1", "down")).toEqual({ focus: "thread:s1" });
  expect(nextTreeMove(rows, "thread:loose", "up")).toEqual({ focus: "thread:loose" });
});

test("home and end jump to the first and last row", () => {
  expect(nextTreeMove(rows, "thread:a2", "home")).toEqual({ focus: "thread:loose" });
  expect(nextTreeMove(rows, "thread:a2", "end")).toEqual({ focus: "thread:s1" });
});

test("right opens a closed folder, then enters an open one", () => {
  expect(nextTreeMove(rows, "project:b", "right")).toEqual({ toggle: true });
  expect(nextTreeMove(rows, "project:a", "right")).toEqual({ focus: "thread:a1" });
  expect(nextTreeMove(rows, "thread:loose", "right")).toBe(null);
});

test("left closes an open folder, then a child goes to its parent", () => {
  expect(nextTreeMove(rows, "project:a", "left")).toEqual({ toggle: true });
  expect(nextTreeMove(rows, "thread:a2", "left")).toEqual({ focus: "project:a" });
  expect(nextTreeMove(rows, "project:b", "left")).toBe(null);
  expect(nextTreeMove(rows, "thread:loose", "left")).toBe(null);
});

test("a row that is gone moves nowhere", () => {
  expect(nextTreeMove(rows, "thread:gone", "down")).toBe(null);
});
