// The fold controls against a fake serve-emu: GET reads "opened", POST answers with the posture asked for.
import { mount, signal, Text, View } from "nsh";
import { DeviceAndroidFoldControls } from "./DeviceAndroidFoldControls";

const log = signal<string[]>([]);
const fetcher = (async (url: string, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  const body = init?.body ? String(init.body) : "";
  log.update((all) => [...all, `${method} ${url} ${body}`]);
  const posture = body ? (JSON.parse(body) as { posture: string }).posture : "opened";
  return { ok: true, status: 200, json: async () => ({ ok: true, fold: { supported: true, posture, hingeAngle: null } }) } as Response;
}) as typeof fetch;
const access = { httpBase: "http://h/api/device-hub", query: { hostId: "local", wsTicket: "T" } };

mount(() => (
  <View class="flex-1 bg-background p-4">
    <Text>{`log=[${log().join(" ; ")}]`}</Text>
    <DeviceAndroidFoldControls access={() => access} deviceKey="env\u0000local\u0000emu-1" deviceId="emu-1" visible={() => true} enabled={() => true} screen={() => ({ width: 1080, height: 2092 })} renewAccess={async () => null} fetcher={fetcher} />
  </View>
));
