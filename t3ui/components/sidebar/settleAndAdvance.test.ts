import { expect, test } from "nsh/test";
import { nextCardAfter } from "./settleAndAdvance";

test("the next card wraps and skips parked and co-settling threads", () => {
  const parked = new Set(["c"]);
  expect(nextCardAfter(["a", "b", "c", "d"], "b", (id) => parked.has(id))).toBe("d");
  expect(nextCardAfter(["a", "b", "c", "d"], "d", (id) => parked.has(id))).toBe("a");
  expect(nextCardAfter(["a", "b"], "b", () => false, new Set(["a"]))).toBe(null);
  expect(nextCardAfter(["a"], "x", () => false)).toBe(null);
});
