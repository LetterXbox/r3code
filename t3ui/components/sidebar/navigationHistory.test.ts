import { expect, test } from "nsh/test";
import { pushPlace, stepIndex } from "./navigationHistory";
import type { History, Place } from "./navigationHistory";

const place = (thread: string | null, page: string | null = null): Place => ({ thread, page });
const empty: History = { places: [], index: -1 };

test("each new place is pushed and a repeat of the current one is ignored", () => {
  const a = pushPlace(empty, place("a"));
  const again = pushPlace(a, place("a"));
  expect(again).toBe(a);
  const b = pushPlace(a, place("b"));
  expect(b.places.length).toBe(2);
  expect(b.index).toBe(1);
});

test("a new place after going back drops the forward places", () => {
  let history = pushPlace(pushPlace(pushPlace(empty, place("a")), place("b")), place("c"));
  history = { ...history, index: 0 };
  history = pushPlace(history, place("d"));
  expect(history.places.map((entry) => entry.thread)).toEqual(["a", "d"]);
  expect(history.index).toBe(1);
});

test("stepping walks both ways and stops at the ends", () => {
  const history: History = { places: [place("a"), place("b"), place("c")], index: 1 };
  expect(stepIndex(history, -1)).toBe(0);
  expect(stepIndex(history, 1)).toBe(2);
  expect(stepIndex({ ...history, index: 0 }, -1)).toBe(null);
  expect(stepIndex({ ...history, index: 2 }, 1)).toBe(null);
});

test("stepping skips places that no longer exist", () => {
  const history: History = { places: [place("a"), place("gone"), place("c")], index: 2 };
  expect(stepIndex(history, -1, (entry) => entry.thread !== "gone")).toBe(0);
  expect(stepIndex(history, -1, (entry) => entry.thread === "gone")).toBe(1);
});

test("a page over a thread is its own place", () => {
  const history = pushPlace(pushPlace(empty, place("a")), place("a", "usage"));
  expect(history.places.length).toBe(2);
});
