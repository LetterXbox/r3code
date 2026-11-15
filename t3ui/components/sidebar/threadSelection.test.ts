import { expect, test } from "nsh/test";
import {
  clearThreadSelection,
  isThreadSelected,
  rangeSelectTo,
  removeFromSelection,
  selectedThreadIds,
  selectionAnchor,
  setSelectionAnchor,
  toggleThreadSelection,
} from "./threadSelection";

const ordered = ["a", "b", "c", "d", "e"];

test("toggling adds and removes a row, and the last added row is the anchor", async () => {
  clearThreadSelection();
  toggleThreadSelection("b");
  toggleThreadSelection("d");
  await expect([...selectedThreadIds()]).toEqual(["b", "d"]);
  await expect(selectionAnchor()).toBe("d");
  toggleThreadSelection("b");
  await expect(isThreadSelected("b")).toBe(false);
  await expect(selectionAnchor()).toBe("d");
});

test("shift-click selects the range from the anchor, in either direction", async () => {
  clearThreadSelection();
  setSelectionAnchor("b");
  rangeSelectTo("d", ordered);
  await expect([...selectedThreadIds()]).toEqual(["b", "c", "d"]);
  clearThreadSelection();
  setSelectionAnchor("d");
  rangeSelectTo("b", ordered);
  await expect([...selectedThreadIds()].sort()).toEqual(["b", "c", "d"]);
});

test("a range with no usable anchor selects just the row and anchors it", async () => {
  clearThreadSelection();
  rangeSelectTo("c", ordered);
  await expect([...selectedThreadIds()]).toEqual(["c"]);
  await expect(selectionAnchor()).toBe("c");
});

test("clearing and removing drop rows and the anchor", async () => {
  clearThreadSelection();
  toggleThreadSelection("a");
  toggleThreadSelection("b");
  removeFromSelection(["b"]);
  await expect([...selectedThreadIds()]).toEqual(["a"]);
  await expect(selectionAnchor()).toBeNull();
  clearThreadSelection();
  await expect(selectedThreadIds().length).toBe(0);
});
