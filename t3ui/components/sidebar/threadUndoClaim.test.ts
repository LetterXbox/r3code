import { expect, test } from "nsh/test";
import { claimThreadUndoShortcut, releaseThreadUndoShortcut, setThreadUndoRunner, takeThreadUndoShortcut } from "./threadUndoClaim";

test("fm13: a fresh notice takes mod+z in a text field until the user edits", () => {
  let ran = 0;
  setThreadUndoRunner(() => { ran += 1; return true; });
  expect(takeThreadUndoShortcut()).toBe(false);
  claimThreadUndoShortcut();
  expect(takeThreadUndoShortcut()).toBe(true);
  releaseThreadUndoShortcut();
  expect(takeThreadUndoShortcut()).toBe(false);
  expect(ran).toBe(1);
});
