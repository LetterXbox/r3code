import { expect, test } from "nsh/test";
import { createHover } from "./hoverReveal";

test("createHover: hovered() is true while the pointer is over the bound element, or a tracked descendant has focus", () => {
  const hover = createHover();
  expect(hover.hovered()).toBe(false);

  hover.bind.onMouseEnter();
  expect(hover.hovered()).toBe(true);
  hover.bind.onMouseLeave();
  expect(hover.hovered()).toBe(false);

  hover.trackFocus.onFocus();
  expect(hover.hovered()).toBe(true);
  hover.trackFocus.onBlur();
  expect(hover.hovered()).toBe(false);

  // Pointer and focus can overlap; leaving one while the other still holds keeps it revealed.
  hover.bind.onMouseEnter();
  hover.trackFocus.onFocus();
  hover.bind.onMouseLeave();
  expect(hover.hovered()).toBe(true);
  hover.trackFocus.onBlur();
  expect(hover.hovered()).toBe(false);
});
