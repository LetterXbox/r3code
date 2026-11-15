import { expect, test } from "nsh/test";
import { threadRowSurface } from "./rowSurface";

test("an unsent draft tints a thread row that is not open, selected or a drop target", () => {
  const base = { active: false, selected: false, fileOver: false, unsentDraft: false };
  expect(threadRowSurface(base)).toBe("bg-transparent hover:bg-sidebar-row-hover");
  expect(threadRowSurface({ ...base, unsentDraft: true })).toBe("bg-warning-4 hover:bg-warning-8");
  // The open thread (the web's isRouteThread) and a selected row keep their own surfaces.
  expect(threadRowSurface({ ...base, unsentDraft: true, active: true })).toBe("bg-sidebar-row-active");
  expect(threadRowSurface({ ...base, unsentDraft: true, selected: true })).toBe("bg-sidebar-row-selected");
  expect(threadRowSurface({ ...base, unsentDraft: true, fileOver: true })).toBe("bg-sidebar-row-hover");
});
