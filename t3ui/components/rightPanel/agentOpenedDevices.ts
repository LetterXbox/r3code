// A device an agent opens (agentOpenedPreviews.ts applyDeviceSnapshot / floatDeviceSurface): it floats over its
// thread's chat, or becomes a panel tab when floating previews are off; the sheet layout gets neither. The first
// snapshot is the baseline, so persisted tabs restore themselves and existing sessions never bring back what the user
// closed. A floating device whose session ended closes. Pure, so it is unit tested; RightPanel.tsx applies the result.
import type { DeviceServiceState } from "../device/deviceLogic";
import type { DeviceTabTarget } from "./panelLogic";

type Session = DeviceServiceState["sessions"][number];

/** `openedAt` tells a session apart from one that ended and reopened on the same device while this client was away. */
export const deviceSessionKey = (session: Session) => `${session.threadId}:${session.hostId}:${session.deviceId}:${session.openedAt}`;

export function hasLiveDeviceSession(state: DeviceServiceState, threadId: string, target: { hostId: string; deviceId: string }): boolean {
  return state.sessions.some((session) => session.threadId === threadId && session.hostId === target.hostId && session.deviceId === target.deviceId);
}

export interface FloatingDevice { readonly threadId: string; readonly target: { hostId: string; deviceId: string } }

export interface DeviceSnapshotResult {
  /** The baseline for the next snapshot. */
  readonly baseline: ReadonlySet<string>;
  /** Threads whose floating device lost its session. */
  readonly close: readonly string[];
  /** New sessions to float (autoShowFloatingPreview on). */
  readonly float: readonly { threadId: string; target: DeviceTabTarget }[];
  /** New sessions to open as a panel tab (autoShowFloatingPreview off; the caller skips a tab already there). */
  readonly openTab: readonly { threadId: string; target: DeviceTabTarget }[];
}

export function applyDeviceSnapshot(
  previous: ReadonlySet<string> | undefined,
  state: DeviceServiceState,
  floating: readonly FloatingDevice[],
  options: { readonly sheetLayout: boolean; readonly autoShowFloatingPreview: boolean },
): DeviceSnapshotResult {
  const deviceFor = (session: Session) => state.devices.find((entry) => entry.hostId === session.hostId && entry.id === session.deviceId);
  const close = floating.filter((entry) => !hasLiveDeviceSession(state, entry.threadId, entry.target)).map((entry) => entry.threadId);
  // A session without a device summary yet stays out of the baseline so a later snapshot opens it.
  const baseline = new Set(state.sessions.filter((session) => deviceFor(session) !== undefined).map(deviceSessionKey));
  const float: { threadId: string; target: DeviceTabTarget }[] = [];
  const openTab: { threadId: string; target: DeviceTabTarget }[] = [];
  if (previous && !options.sheetLayout) {
    for (const session of state.sessions) {
      if (previous.has(deviceSessionKey(session))) continue;
      const device = deviceFor(session);
      if (!device) continue;
      const target: DeviceTabTarget = { hostId: session.hostId, deviceId: session.deviceId, platform: device.platform, name: device.name };
      (options.autoShowFloatingPreview ? float : openTab).push({ threadId: session.threadId, target });
    }
  }
  return { baseline, close, float, openTab };
}
