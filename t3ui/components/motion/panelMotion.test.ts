import { expect, test } from "nsh/test";
import { updateSetting } from "../../store";
import { panelAnimationMs } from "./panelMotion";

test("fm13: the panel animation follows the setting; reduced motion and a fresh navigation turn it off", () => {
  updateSetting("panelAnimationDurationMs", 200);
  const now = 10_000_000;
  panelAnimationMs(now);
  expect(panelAnimationMs(now + 1000)).toBe(200);
  updateSetting("panelAnimationDurationMs", 0);
  expect(panelAnimationMs(now + 2000)).toBe(0);
});
