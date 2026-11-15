import { expect, test } from "nsh/test";
import {
  clampThreadSidebarWidth,
  draggedSidebarWidth,
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
} from "./sidebarWidth";

test("the width starts at 16rem and never goes under 13rem", () => {
  expect(resolveInitialThreadSidebarWidth(null, 1280)).toBe(256);
  expect(resolveInitialThreadSidebarWidth(100, 1280)).toBe(208);
  expect(resolveInitialThreadSidebarWidth(400, 1280)).toBe(400);
});

test("the main column keeps 40rem, so a narrow window caps the sidebar", () => {
  expect(resolveThreadSidebarMaximumWidth(1280)).toBe(640);
  expect(resolveInitialThreadSidebarWidth(600, 800)).toBe(208);
  expect(resolveThreadSidebarMaximumWidth(500)).toBe(208);
});

test("a drag adds the pointer travel to the start and clamps", () => {
  expect(draggedSidebarWidth(256, 80, 1280)).toBe(336);
  expect(draggedSidebarWidth(256, -400, 1280)).toBe(208);
  expect(draggedSidebarWidth(256, 900, 1280)).toBe(640);
  expect(clampThreadSidebarWidth(300, 208, 640)).toBe(300);
});
