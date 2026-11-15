import { expect, test } from "nsh/test";
import type { DesktopSnapShotState } from "../../../desktop/snapShotTypes";
import { snapShotFeedbackUnavailableMessage } from "./SnapShotSettings.logic";

const direct = (macFlashAvailable?: boolean): DesktopSnapShotState => ({
  mode: "direct",
  shortcut: { kind: "both-shift-keys" },
  shortcutRegistered: false,
  shortcutMessage: null,
  message: null,
  macFlashAvailable,
});

test("on macOS (mode direct), the flash/animation toggles disable themselves until a host build understands snapshot.flash", () => {
  expect(snapShotFeedbackUnavailableMessage(direct(false))).toBe("Update R3 Code to enable capture effects.");
  expect(snapShotFeedbackUnavailableMessage(direct(undefined))).toBe("Update R3 Code to enable capture effects.");
  expect(snapShotFeedbackUnavailableMessage(direct(true))).toBe(undefined);
});

test("a null state (not read yet) and the linux portal modes are unaffected", () => {
  expect(snapShotFeedbackUnavailableMessage(null)).toBe(undefined);
});
