import { mount, signal, Text, View } from "nsh";
import { DevicePanel } from "./DevicePanel";
import { overrideWebViewsUnderSurface } from "../rightPanel/nativeOcclusion";

// A thread with a booted iOS simulator open (session S2) on a local host: the device workspace, its rail and Tools pane.
const log = signal<string[]>([]);
const platform = (globalThis as { DEVICE_FIXTURE_PLATFORM?: "ios" | "android" }).DEVICE_FIXTURE_PLATFORM ?? "ios";
const wire = {
  hosts: [{ id: "local", label: "This machine", kind: "local", platforms: [{ platform, available: true }], hubInstalled: true, agentDeviceInstalled: true }],
  hostStatus: "ready", hostStatuses: { local: { status: "ready", detail: "Android emulator discovery timed out." } },
  devices: [{ hostId: "local", id: "S2", platform, name: (globalThis as { DEVICE_FIXTURE_NAME?: string }).DEVICE_FIXTURE_NAME ?? "iPhone SE", version: "17.2", booted: true, physical: false }, { hostId: "local", id: "S3", platform, name: "Second device", version: "17.2", booted: true, physical: false }],
  sessions: [{ threadId: "t1", hostId: "local", deviceId: "S2", platform, openedAt: "2026-11-12T00:00:00Z" }, { threadId: "t1", hostId: "local", deviceId: "S3", platform, openedAt: "2026-11-12T00:00:01Z" }], onboardingCompleted: true, agentAccessEnabled: false, hubBasePath: "/api/device-hub", revision: 1,
};
const subscribe = (_m: string, _p: unknown, onValue: (v: unknown) => void) => { setTimeout(() => onValue(wire), 0); return () => {}; };
const detail = (settings: Record<string, unknown>) => ({ hostId: "local", deviceId: "S2", settings, foregroundApp: { id: "com.example.app" }, readAt: "2026-11-12T00:00:00Z" });
let deviceSettings: Record<string, unknown> = { appearance: "light", textSize: "default", reduceMotion: false, liquidGlass: "clear", colorFilter: "none" };
const selectedDevice = signal("S2");
const request = async (method: string, payload: unknown) => {
  log.update((all) => [...all, `${method}:${JSON.stringify(payload)}`]);
  if (method === "device.action" && payload && typeof payload === "object") {
    const action = payload as { type?: string; value?: unknown };
    if (action.type === "setAppearance") deviceSettings = { ...deviceSettings, appearance: action.value };
    if (action.type === "setLiquidGlass") deviceSettings = { ...deviceSettings, liquidGlass: action.value };
  }
  if (method === "device.detail" || method === "device.action") return detail(deviceSettings);
  return {};
};

mount(() => (
  <View class="flex-1 bg-background">
    <View role="button" accessibilityLabel="Enable under-surface WebViews" onPress={() => overrideWebViewsUnderSurface(true)}><Text>Enable under-surface WebViews</Text></View>
    <View role="button" accessibilityLabel="Switch device target" onPress={() => selectedDevice.set("S3")}><Text>Switch device target</Text></View>
    <Text>{`log=[${log().join(" ; ")}]`}</Text>
    <DevicePanel surface={{ id: "device", kind: "device", target: { hostId: "local", deviceId: selectedDevice() } } as never} threadId="t1" visible={() => true} subscribe={subscribe as never} request={request}
      onCloseSurface={() => {}} onOpened={() => {}} />
  </View>
));
