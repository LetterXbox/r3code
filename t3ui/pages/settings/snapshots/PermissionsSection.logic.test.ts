import { expect, test } from "nsh/test";
import type { PermissionsStatus } from "../../../desktop/permissionsHelper";
import {
  PERMISSION_ROWS, permissionBooleanStatus, permissionGranted, permissionRowStatus, permissionStatusLabel,
} from "./PermissionsSection.logic";

test("two rows, one per permission the helper tracks", () => {
  expect(PERMISSION_ROWS.map((row) => row.id)).toEqual(["accessibility", "screen-recording"]);
  expect(PERMISSION_ROWS.map((row) => row.statusKey)).toEqual(["accessibility", "screenRecording"]);
});

test("permissionStatusLabel names each state", () => {
  expect(permissionStatusLabel("granted")).toBe("Granted");
  expect(permissionStatusLabel("denied")).toBe("Not granted");
  expect(permissionStatusLabel("unknown")).toBe("Not checked yet");
});

test("permissionGranted is true only for granted", () => {
  expect(permissionGranted("granted")).toBe(true);
  expect(permissionGranted("denied")).toBe(false);
  expect(permissionGranted("unknown")).toBe(false);
});

test("permissionRowStatus reads the row's own key, and is unknown before any status exists", () => {
  const status: PermissionsStatus = { accessibility: "granted", screenRecording: "unknown" };
  expect(permissionRowStatus(status, PERMISSION_ROWS[0])).toBe("granted");
  expect(permissionRowStatus(status, PERMISSION_ROWS[1])).toBe("unknown");
  expect(permissionRowStatus(null, PERMISSION_ROWS[0])).toBe("unknown");
});

test("permissionBooleanStatus collapses both rows to granted/not-granted for the poller", () => {
  expect(permissionBooleanStatus({ accessibility: "granted", screenRecording: "unknown" })).toEqual({ accessibility: true, screenRecording: false });
  expect(permissionBooleanStatus({ accessibility: "denied", screenRecording: "granted" })).toEqual({ accessibility: false, screenRecording: true });
  expect(permissionBooleanStatus(null)).toEqual({ accessibility: false, screenRecording: false });
});
