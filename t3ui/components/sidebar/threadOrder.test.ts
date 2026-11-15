import { expect, test } from "nsh/test";
import { moveToIndex, orderKeyBetween, planReorder, sortActiveByKey, sortPinnedByKey, spreadOrderKeys } from "./threadOrder";

test("a key between two neighbours sorts strictly between them", async () => {
  const key = orderKeyBetween("c", "e");
  await expect(key).toBe("d");
  await expect(orderKeyBetween(null, null)).toBe("n");
  const between = orderKeyBetween("d", "e");
  await expect(between !== null && between > "d" && between < "e").toBe(true);
  const top = orderKeyBetween(null, "c");
  await expect(top !== null && top < "c").toBe(true);
  await expect(orderKeyBetween("e", "c")).toBeNull();
  await expect(orderKeyBetween("a", "c")).toBeNull();
});

test("spread keys are increasing, distinct and never end in the minimum digit", async () => {
  const keys = spreadOrderKeys(30);
  await expect(new Set(keys).size).toBe(30);
  await expect(keys.every((key, index) => index === 0 || keys[index - 1]! < key)).toBe(true);
  await expect(keys.every((key) => !key.endsWith("a"))).toBe(true);
});

test("moving a row between keyed neighbours writes one key", async () => {
  const keys = new Map<string, string | null>([["a", "c"], ["b", "g"], ["c", "p"]]);
  const plan = planReorder({ orderedIds: ["a", "c", "b"], keysById: keys, movedId: "c" });
  await expect(plan.length).toBe(1);
  await expect(plan[0]!.id).toBe("c");
  await expect(plan[0]!.orderKey > "c" && plan[0]!.orderKey < "g").toBe(true);
});

test("keyless neighbours respread the whole section", async () => {
  const keys = new Map<string, string | null>([["a", null], ["b", null], ["c", null]]);
  const plan = planReorder({ orderedIds: ["b", "a", "c"], keysById: keys, movedId: "a" });
  await expect(plan.map((item) => item.id)).toEqual(["b", "a", "c"]);
  await expect(plan[0]!.orderKey < plan[1]!.orderKey && plan[1]!.orderKey < plan[2]!.orderKey).toBe(true);
});

test("hidden rows keep their keys reserved", async () => {
  const keys = new Map<string, string | null>([["a", "c"], ["b", "g"], ["hidden", "d"]]);
  const plan = planReorder({ orderedIds: ["b", "a"], keysById: keys, movedId: "b" });
  await expect(plan.every((item) => item.orderKey !== "d")).toBe(true);
});

test("pinned sort puts keyed rows first, active sort puts keyless rows first", async () => {
  const rows = [
    { id: "x", meta: { pinOrderKey: null, activeOrderKey: null } },
    { id: "y", meta: { pinOrderKey: "m", activeOrderKey: "m" } },
    { id: "z", meta: { pinOrderKey: "c", activeOrderKey: "c" } },
  ];
  await expect(sortPinnedByKey(rows).map((row) => row.id)).toEqual(["z", "y", "x"]);
  await expect(sortActiveByKey(rows).map((row) => row.id)).toEqual(["x", "z", "y"]);
  const plain = [{ id: "p" }, { id: "q" }];
  await expect(sortPinnedByKey(plain).map((row) => row.id)).toEqual(["p", "q"]);
});

test("keyless pinned and active rows use the reference timestamps rather than arrival order", () => {
  const rows = [
    { id: "old", createdAt: 10, meta: { pinOrderKey: null, unsettledAt: 40 } },
    { id: "new", createdAt: 30, meta: { pinOrderKey: null, unsettledAt: null } },
    { id: "middle", createdAt: 20, meta: { pinOrderKey: null, unsettledAt: null } },
  ];
  expect(sortPinnedByKey(rows).map((row) => row.id)).toEqual(["new", "middle", "old"]);
  expect(sortActiveByKey(rows).map((row) => row.id)).toEqual(["old", "new", "middle"]);
});

test("equal timestamp rows break ties by local thread id before environment", () => {
  const rows = [{ id: "z:aaa", environmentId: "z", createdAt: 10 }, { id: "a:bbb", environmentId: "a", createdAt: 10 }];
  expect(sortActiveByKey(rows).map((row) => row.id)).toEqual(["z:aaa", "a:bbb"]);
  expect(sortPinnedByKey(rows).map((row) => row.id)).toEqual(["z:aaa", "a:bbb"]);
});

test("moveToIndex drops the row at a slot among the others", async () => {
  await expect(moveToIndex(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
  await expect(moveToIndex(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
  await expect(moveToIndex(["a", "b", "c"], "b", 9)).toEqual(["a", "c", "b"]);
});
