import { expect, test } from "nsh/test";
import { shortcutModifiers, shouldShowThreadJumpHints } from "./jumpHints";

const none = { control: false, alt: false, shift: false, platform: false };
const rules = [{ command: "thread.jump.1", key: "mod+1" }, { command: "chat.new", key: "mod+shift+o" }];

test("jump hints show only for exactly the jump shortcut's modifiers, never in the terminal", () => {
  expect(shortcutModifiers("mod+1")).toEqual({ ...none, platform: true });
  expect(shouldShowThreadJumpHints({ ...none, platform: true }, rules, false)).toBe(true);
  expect(shouldShowThreadJumpHints({ ...none, platform: true, shift: true }, rules, false)).toBe(false);
  expect(shouldShowThreadJumpHints({ ...none, platform: true }, rules, true)).toBe(false);
  expect(shouldShowThreadJumpHints(none, rules, false)).toBe(false);
});
