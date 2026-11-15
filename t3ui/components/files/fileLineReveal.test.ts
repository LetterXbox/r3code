import { expect, test } from "nsh/test";
import { revealIndex } from "./fileLineReveal";

test("a line becomes a clamped zero-based row", () => {
  expect(revealIndex(1, 10)).toBe(0);
  expect(revealIndex(7, 10)).toBe(6);
  expect(revealIndex(99, 10)).toBe(9);
  expect(revealIndex(0, 10)).toBe(0);
  expect(revealIndex(undefined, 10)).toBe(null);
  expect(revealIndex(3, 0)).toBe(null);
  expect(revealIndex(Number.NaN, 5)).toBe(null);
});
