import { mount, signal, Text, View } from "nsh";
import { setBackendStatusForTest } from "../../store";
import { DeviceStreamView } from "./DevicePanel";
import type { DeviceSummary } from "./deviceLogic";

setBackendStatusForTest("connected", "ws://test.invalid/ws");
const device = signal<DeviceSummary>({ hostId: "local", id: "s1", platform: "ios", name: "iPhone", version: "27", booted: true, physical: false });
const hosts = signal<string[]>([]);
mount(() => <View class="flex-1">
  <Text onPress={() => device.set({ ...device(), hostId: "remote", id: "s2" })}>Switch device</Text>
  <Text>{`access:${hosts().join(",")}`}</Text>
  <DeviceStreamView device={device()} hostLabel="Host" hostKind="local" hubBasePath="/api/device-hub" visible={() => true} occluded={() => false}
    input={{ bind: () => {}, onConnected: () => {}, onAccess: (access) => hosts.update((all) => [...all, access.query.hostId!]) }} />
</View>);
