import { expect, test } from "nsh/test";
import type { SocketConnection } from "../backend/client";
import { configureSettingsTarget, readSetting, writeSetting } from "../pages/settings/settingsSync";
import { environmentConfigs, resetEnvironmentsForTest, setEnvironmentTransportForTest, syncEnvironments } from "./connectionManager";

class FakeSocket implements SocketConnection {
  sent: string[] = [];
  private incoming: (string | null)[] = [];
  private reader: ((value: string | null) => void) | null = null;
  async write(data: string | Uint8Array) { this.sent.push(typeof data === "string" ? data : new TextDecoder().decode(data)); }
  read(): Promise<string | Uint8Array | null> {
    if (this.incoming.length) return Promise.resolve(this.incoming.shift() ?? null);
    return new Promise((resolve) => { this.reader = resolve; });
  }
  async close() { this.push(null); }
  push(value: string | null) { const r = this.reader; this.reader = null; if (r) r(value); else this.incoming.push(value); }
  frame(value: unknown) { this.push(JSON.stringify(value)); }
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}
const idOf = (socket: FakeSocket, method: string) => (JSON.parse(socket.sent.find((text) => text.includes(method)) ?? "{}") as { id?: string }).id;

test("settings read from and write to the saved environment the scope selects", async () => {
  const socket = new FakeSocket();
  setEnvironmentTransportForTest({ ticket: async (url) => url, open: async () => socket });
  syncEnvironments([{ id: "saved:box", label: "box", url: "ws://box/ws", enabled: true }]);
  await until(() => idOf(socket, "subscribeServerConfig") !== undefined);
  socket.frame({ _tag: "Chunk", requestId: idOf(socket, "subscribeServerConfig"), values: [{ type: "snapshot", config: { settings: { remoteOnlyField: "remote" } } }] });
  await until(() => environmentConfigs()["saved:box"] !== undefined);
  configureSettingsTarget(() => "saved:box");
  expect(readSetting("remoteOnlyField", "server")).toBe("remote");
  const write = writeSetting("remoteOnlyField", "server", "changed");
  await until(() => idOf(socket, "server.updateSettings") !== undefined);
  socket.frame({ _tag: "Exit", requestId: idOf(socket, "server.updateSettings"), exit: { _tag: "Success", value: { remoteOnlyField: "changed" } } });
  await write;
  expect(readSetting("remoteOnlyField", "server")).toBe("changed");
  configureSettingsTarget(() => null);
  resetEnvironmentsForTest();
  setEnvironmentTransportForTest(null);
});
