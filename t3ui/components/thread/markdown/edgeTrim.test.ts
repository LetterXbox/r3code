import { expect, test } from "nsh/test";
import { trimBottomClass, trimTopClass } from "./edgeTrim";

test("the first and last block margins are cancelled by their own size", () => {
  expect(trimTopClass("hello")).toBe("-mt-[0.65rem]");
  expect(trimBottomClass("hello\n\nbye")).toBe("-mb-[0.65rem]");
  expect(trimTopClass("\n# Title\n\nbody")).toBe("-mt-5");
  expect(trimBottomClass("body\n\n## Tail\n")).toBe("-mb-2");
  expect(trimTopClass("---\ntext")).toBe("-mt-4");
  expect(trimTopClass("- a\n- b")).toBe("-mt-[0.65rem]");
});
