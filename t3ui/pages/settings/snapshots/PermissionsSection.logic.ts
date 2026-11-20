// The settings surface for desktop/permissionsHelper.ts (DESKTOP_PARITY_AUDIT.md H4): pure formatting only, no
// bridge calls, so this stays testable without nsh/test's desktop fakes. PermissionsSection.tsx renders these.
import type { PermissionsStatus, PermissionState } from "../../../desktop/permissionsHelper";

export type PermissionRowId = "accessibility" | "screen-recording";

export interface PermissionRowSpec {
  id: PermissionRowId;
  statusKey: keyof PermissionsStatus;
  title: string;
  description: string;
}

export const PERMISSION_ROWS: PermissionRowSpec[] = [
  {
    id: "accessibility",
    statusKey: "accessibility",
    title: "Accessibility",
    description: "Lets R3 Code read the active window's title, for SnapShots and app text capture.",
  },
  {
    id: "screen-recording",
    statusKey: "screenRecording",
    title: "Screen Recording",
    description: "Lets R3 Code capture a window, for SnapShots.",
  },
];

export function permissionStatusLabel(state: PermissionState): string {
  if (state === "granted") return "Granted";
  if (state === "denied") return "Not granted";
  return "Not checked yet";
}

export function permissionGranted(state: PermissionState): boolean {
  return state === "granted";
}

/** The row this status belongs to, "unknown" before any status has been read. */
export function permissionRowStatus(status: PermissionsStatus | null, row: PermissionRowSpec): PermissionState {
  return status?.[row.statusKey] ?? "unknown";
}

/** createPermissionPoller's boolean record: both rows collapse to granted/not-granted; each row's own copy
 * already explains what "not granted" means for it (denied vs. never checked). */
export function permissionBooleanStatus(status: PermissionsStatus | null): Record<"accessibility" | "screenRecording", boolean> {
  return { accessibility: status?.accessibility === "granted", screenRecording: status?.screenRecording === "granted" };
}
