// The setup wizard with a remote host that failed to start (DeviceHostUpdates) on a server that can retry one host.
import { mount, signal, Text, View } from "nsh";
import { DeviceSetupBody } from "./DeviceSetup";
import { readDeviceState } from "./deviceLogic";

const log = signal<string[]>([]);
const state = readDeviceState({
  hosts: [{ id: "local", label: "This machine", kind: "local", platforms: [{ platform: "ios", available: true }], hubInstalled: true, agentDeviceInstalled: true }, { id: "mac", label: "Studio Mac", kind: "ssh", platforms: [], hubInstalled: false, agentDeviceInstalled: false }],
  hostStatus: "ready", hostStatuses: { local: { status: "ready" }, mac: { status: "failed", detail: "ssh: connect to host timed out" } },
  devices: [], sessions: [], onboardingCompleted: false, agentAccessEnabled: true, supportsHostRetry: true, hubBasePath: "/api/device-hub", revision: 1,
})!;
const request = async (method: string, payload: unknown) => { log.update((all) => [...all, `${method}:${JSON.stringify(payload)}`]); return {}; };

mount(() => (
  <View class="flex-1 bg-background p-4">
    <Text>{`log=[${log().join(" ; ")}]`}</Text>
    <DeviceSetupBody state={() => state} onComplete={() => {}} onCancel={() => {}} request={request} />
  </View>
));
