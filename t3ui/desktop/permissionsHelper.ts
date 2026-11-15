// permissions/MacPermissionHelper.ts + MacPermissions.ts, scaled to what NSH can ask without native code: a single
// status read (Accessibility via the host's own AXIsProcessTrusted, or osascript; Screen Recording from the last
// capture's own answer, snapShot.ts's own tracking) plus the two actions a helper offers -- open the right System
// Settings pane, and re-check. This composes snapShot.ts's existing checks instead of re-reading the TCC database
// or duplicating its storage key, so this and the SnapShot setup dialog never disagree about what is granted.
//
// No MacSettingsWindow-equivalent dialog is wired up to navigation yet: this is the status/actions module a future
// permissions screen would read, with its own passing tests (see the report).
import { accessibilityTrusted } from "./snapShotActiveWindow";
import { MAC_PERMISSION_SETTINGS_URLS, openMacPermissionSettings, screenRecordingGranted, testMacCapture } from "./snapShot";
import { isMac } from "./runtime";

export type PermissionState = "granted" | "denied" | "unknown";

export interface PermissionsStatus {
  accessibility: PermissionState;
  /** macOS offers no query for this one: "unknown" until a capture has actually been tried. */
  screenRecording: PermissionState;
}

export const UNSUPPORTED_PLATFORM_MESSAGE = "Permissions are not tracked on this platform.";

/** The status a helper screen would show; null on a platform with nothing to track (snapShot.ts's own "unavailable" mode). */
export async function permissionsStatus(): Promise<PermissionsStatus | null> {
  if (!isMac()) return null;
  const [accessibility, screenRecording] = await Promise.all([accessibilityTrusted(), screenRecordingGranted()]);
  return { accessibility: accessibility ? "granted" : "denied", screenRecording: screenRecording ? "granted" : "unknown" };
}

/** "Open System Settings" for one permission (MAC_PERMISSION_SETTINGS_URLS' two TCC panes). */
export function openPermissionSettings(permission: "accessibility" | "screen-recording"): Promise<boolean> {
  return openMacPermissionSettings(permission);
}

/** "Check again": Accessibility re-reads at once; Screen Recording has no query, so this runs the same discardable
 * test capture the SnapShot setup dialog uses to settle it. */
export async function recheckPermission(permission: "accessibility" | "screen-recording"): Promise<PermissionState> {
  if (permission === "accessibility") return (await accessibilityTrusted()) ? "granted" : "denied";
  const result = await testMacCapture();
  return result.status === "captured" ? "granted" : result.status === "denied" ? "denied" : "unknown";
}

export { MAC_PERMISSION_SETTINGS_URLS };
