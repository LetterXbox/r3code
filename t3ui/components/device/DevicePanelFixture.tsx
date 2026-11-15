import { mount, signal, Text, View } from "nsh";
import { DevicePanel } from "./DevicePanel";

const log = signal<string[]>([]);
const wire = (over: Record<string, unknown> = {}) => ({
  hosts: [{ id: "local", label: "This machine", kind: "local", platforms: [{ platform: "ios", available: true }], hubInstalled: true, agentDeviceInstalled: true }],
  hostStatus: "ready", hostStatuses: { local: { status: "ready" } },
  devices: [{ hostId: "local", id: "S1", platform: "ios", name: "iPhone 15", version: "17.2", booted: false, physical: false }, { hostId: "local", id: "S2", platform: "ios", name: "iPhone SE", version: "17.2", booted: true, physical: false }],
  sessions: [], onboardingCompleted: true, agentAccessEnabled: false, hubBasePath: "/api/device-hub", revision: 1, ...over,
});
// Simulates the server pushing several snapshots in a row (as it does while a device boots), each with a new
// `revision` but the same hostStatus: the panel must probe with device.list once for that, not once per push.
const subscribe = (_m: string, _p: unknown, onValue: (v: unknown) => void) => {
  let revision = 1;
  const push = () => { onValue(wire({ revision: revision++ })); if (revision <= 4) setTimeout(push, 0); };
  setTimeout(push, 0);
  return () => {};
};
const request = async (method: string, payload: unknown) => { log.update((all) => [...all, `${method}:${JSON.stringify(payload)}`]); return method === "device.open" ? { hostId: "local", deviceId: (payload as { deviceId: string }).deviceId } : {}; };

mount(() => (
  <View class="flex-1 bg-background">
    <Text>{`log=[${log().join(" ; ")}]`}</Text>
    <DevicePanel surface={{ id: "device", kind: "device" }} threadId="t1" visible={() => true} subscribe={subscribe as never} request={request}
      onCloseSurface={() => log.update((all) => [...all, "closed"])} onOpened={(target) => log.update((all) => [...all, `opened:${target.name}`])} />
  </View>
));
