import { expect, test } from "nsh/test";
import { setMarkdownTaskChecked, taskMarkerOffsets } from "./markdownTaskList";

const TEXT = "- [ ] one\n  - [x] nested\n\n```\n- [ ] not a task\n```\n\n1. [ ] numbered\n> - [X] quoted\n- plain";

test("task markers are found in reading order and not inside code", () => {
  const offsets = taskMarkerOffsets(TEXT);
  expect(offsets.map((offset) => TEXT.slice(offset, offset + 3))).toEqual(["[ ]", "[x]", "[ ]", "[X]"]);
  expect(offsets[2]).toBe(TEXT.indexOf("[ ] numbered"));
});

test("toggling writes x or a space at the marker and leaves other offsets alone", () => {
  const offsets = taskMarkerOffsets(TEXT);
  expect(setMarkdownTaskChecked(TEXT, offsets[0]!, true).startsWith("- [x] one")).toBe(true);
  expect(setMarkdownTaskChecked(TEXT, offsets[1]!, false)).toContain("  - [ ] nested");
  expect(setMarkdownTaskChecked(TEXT, 3, true)).toBe(TEXT);
});
