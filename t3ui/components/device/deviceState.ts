// The Device surface's connection to the server (state/device.ts): the `subscribeDeviceState` stream and the device RPCs
// (`device.list`, `.open`, `.close`, `.configure`, `.detail`, `.action`, `.shutdown`). The server is the one the app is paired with.
import { effect, signal } from "nsh";
import { backendStatus, backendUrl, requestBackend, subscribeBackend } from "../../store";
import { EMPTY_DEVICE_STATE, readDeviceState, type DeviceServiceState } from "./deviceLogic";

type Subscribe = (method: string, payload: unknown, onValue: (value: unknown) => void, onError: (error: Error) => void) => () => void;
export type DeviceRequest = (method: string, payload: unknown) => Promise<unknown>;

/** The newest state any watcher read, so the launcher can tell a set-up environment from one that is not without a watcher of its own. */
export const knownDeviceState = signal<DeviceServiceState | null>(null);

export interface DeviceStateWatch {
  state: () => DeviceServiceState;
  loaded: () => boolean;
  error: () => string | null;
  refresh: () => void;
}

/** useDeviceState: follows the stream while the calling component lives and re-subscribes on a new connection or `refresh`. */
export function watchDeviceState(subscribe: Subscribe = subscribeBackend): DeviceStateWatch {
  const state = signal<DeviceServiceState>(EMPTY_DEVICE_STATE);
  const loaded = signal(false);
  const error = signal<string | null>(null);
  const attempt = signal(0);
  effect(() => {
    void attempt();
    void backendUrl();
    if (subscribe === subscribeBackend && backendStatus() !== "connected") { loaded.set(false); return; }
    const stop = subscribe("subscribeDeviceState", {}, (value) => {
      const next = readDeviceState(value);
      if (!next) return;
      state.set(next);
      knownDeviceState.set(next);
      loaded.set(true);
      error.set(null);
    }, (cause) => { error.set(cause.message); });
    return () => { stop(); };
  });
  return { state: () => state(), loaded: () => loaded(), error: () => error(), refresh: () => attempt.update((count) => count + 1) };
}

export const errorMessage = (cause: unknown): string => (cause instanceof Error && cause.message ? cause.message : "The device request failed.");

export const deviceList = (input: { updateTool?: "hub" | "agent"; inspectOnly?: boolean; retryHostId?: string } = {}, request: DeviceRequest = requestBackend) => request("device.list", input);
export const deviceConfigure = (input: { enabled?: boolean; agentAccessEnabled?: boolean; onboardingCompleted?: boolean }, request: DeviceRequest = requestBackend) => request("device.configure", input);
export const deviceOpen = (input: { threadId: string; hostId?: string; deviceId: string; platform: "ios" | "android"; boot?: boolean }, request: DeviceRequest = requestBackend) => request("device.open", input);
export const deviceClose = (input: { threadId: string; hostId?: string; deviceId?: string; shutdown?: boolean }, request: DeviceRequest = requestBackend) => request("device.close", input);
export const deviceDetail = (input: { hostId?: string; deviceId: string }, request: DeviceRequest = requestBackend) => request("device.detail", input);
export const deviceAction = (input: Record<string, unknown> & { deviceId: string; type: string }, request: DeviceRequest = requestBackend) => request("device.action", input);

/** openDeviceSetupDialog (device setup store): the setup wizard, for an environment where devices are not set up yet. */
export const deviceSetupOpen = signal(false);
