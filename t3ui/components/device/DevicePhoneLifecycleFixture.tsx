import { mount, signal, Text, View } from "nsh";
import { setBackendStatusForTest } from "../../store";
import { DevicePhoneView } from "./DevicePhoneView";
import { overrideViewerAssets, overrideViewerFirstFrameMs } from "./deviceViewer";
import type { DeviceSummary } from "./deviceLogic";

setBackendStatusForTest("connected", "ws://test.invalid/ws");
overrideViewerFirstFrameMs(500);
const visible = signal(true);
const calls = signal(0);
const fallbacks = signal(0);
overrideViewerAssets(async (name) => {
  calls.update((n) => n + 1);
  await new Promise((resolve) => setTimeout(resolve, 650));
  return name === "document" ? "<!doctype html><html><body><script>window.config=__T3_VIEWER_CONFIG__</script></body></html>" : "R0xC";
});
const device = signal<DeviceSummary>({ hostId: "local", id: "s1", platform: "ios", name: "iPhone 18 Pro", version: "27", booted: true, physical: false });
const accessHosts = signal<string[]>([]);
mount(() => <View class="flex-1">
  <Text onPress={() => visible.set(!visible())}>Toggle visibility</Text>
  <Text onPress={() => device.set({ ...device(), hostId: "remote", id: "s2" })}>Switch device</Text>
  <Text>{`assets:${calls()} fallback:${fallbacks()}`}</Text>
  <Text>{`access:${accessHosts().join(",")}`}</Text>
  <DevicePhoneView device={device()} hostKind="local" hubBasePath="/api/device-hub" visible={visible} keyboardAttached={() => false} foldAngle={() => null} bind={() => {}} onReport={() => {}} onAccess={(access) => accessHosts.update((hosts) => [...hosts, access.query.hostId!])} onNoVideo={() => fallbacks.update((n) => n + 1)} occluded={() => false} />
</View>);
