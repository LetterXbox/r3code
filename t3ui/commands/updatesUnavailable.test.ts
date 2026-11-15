// "Check for Updates..." in a build with no updater: DesktopApplicationMenu's "Updates unavailable" box, shown as a toast.
import { expect, test } from "nsh/test";
import { showUpdatesUnavailable } from "./appCommands";
import { clearToasts, toastById } from "../components/toast/toastState";

test("the item says Updates unavailable with the reason, and claims nothing was checked", () => {
  clearToasts();
  const toast = toastById(showUpdatesUnavailable());
  expect(toast?.title).toBe("Updates unavailable");
  expect(toast?.description).toBe("Automatic updates are not available right now.\nAutomatic updates are not available because no update feed is configured.");
  clearToasts();
});
