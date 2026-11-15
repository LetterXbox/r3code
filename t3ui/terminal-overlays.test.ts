import { expect, test } from "nsh/test";
import { closeAddProject, showAddProject } from "./components/SidebarAddProjectState";
import { terminalOverlayOpen } from "./pages/ThreadView";
import { closePalette, closeSettings, closeUsage, openPalette, openSettings, openUsage } from "./store";

test("terminal is obscured while any GPUI overlay is open", () => {
  expect(terminalOverlayOpen()).toBe(false);
  for (const [open, close] of [
    [openSettings, closeSettings],
    [openUsage, closeUsage],
    [openPalette, closePalette],
    [showAddProject, closeAddProject],
  ]) {
    open();
    expect(terminalOverlayOpen()).toBe(true);
    close();
    expect(terminalOverlayOpen()).toBe(false);
  }

  openSettings();
  openPalette();
  closeSettings();
  expect(terminalOverlayOpen()).toBe(true);
  closePalette();
  expect(terminalOverlayOpen()).toBe(false);
});
