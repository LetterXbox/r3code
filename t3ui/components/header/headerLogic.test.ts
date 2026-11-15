import { expect, test } from "nsh/test";
import { formatShortcut, resolveRenameCommit, shortcutLabelForCommand, withShortcut } from "./headerLogic";

test("rename commit rejects empty, ignores unchanged, trims changes", () => {
  expect(resolveRenameCommit({ title: "   ", originalTitle: "A" })).toEqual({ action: "reject-empty" });
  expect(resolveRenameCommit({ title: " A ", originalTitle: "A" })).toEqual({ action: "noop" });
  expect(resolveRenameCommit({ title: " B ", originalTitle: "A" })).toEqual({ action: "commit", title: "B" });
});

test("shortcut labels follow the web's platform formatting", () => {
  expect(shortcutLabelForCommand("terminal.toggle", true)).toBe("⌘J");
  expect(shortcutLabelForCommand("rightPanel.toggle", true)).toBe("⌥⌘B");
  expect(shortcutLabelForCommand("threadPanel.toggle", true)).toBe("⇧⌘B");
  expect(formatShortcut("mod+shift+b", false)).toBe("Ctrl+Shift+B");
  expect(withShortcut("Toggle terminal drawer", "⌘J")).toBe("Toggle terminal drawer (⌘J)");
  expect(withShortcut("Toggle terminal drawer", null)).toBe("Toggle terminal drawer");
});

import { shouldCollapseParentTitle } from "./headerLogic";

test("the parent title collapses once the breadcrumb no longer fits", () => {
  const input = { projectName: "demo", parentTitle: "Plan the work", title: "Fix the build" };
  expect(shouldCollapseParentTitle({ ...input, available: 700 })).toBe(false);
  expect(shouldCollapseParentTitle({ ...input, available: 260 })).toBe(true);
  expect(shouldCollapseParentTitle({ ...input, projectName: null, available: 260 })).toBe(false);
});
