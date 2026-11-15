import { expect, test } from "nsh/test";
import { hasCommandHandler } from "../../commands/registry";
import { bindPanelKeys } from "./panelKeys";

test("rightPanel.toggleMaximized has a handler while the panel keys are bound", () => {
  const off = bindPanelKeys();
  expect(hasCommandHandler("rightPanel.toggleMaximized")).toBe(true);
  off();
});
