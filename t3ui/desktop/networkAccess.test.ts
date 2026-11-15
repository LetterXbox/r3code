import { expect, test } from "nsh/test";
import { createNetworkAccess, parseSnapshot, type NetworkAccessIo } from "./networkAccess";

const state = (mode: string, extra: Record<string, unknown> = {}) => JSON.stringify({ serverExposureState: { mode, endpointUrl: null, advertisedHost: null, tailscaleServeEnabled: false, tailscaleServePort: 443 }, advertisedEndpoints: [], ...extra });

test("a mode change is a request the launcher answers by id", async () => {
  const files = new Map<string, string>([["/b/exposure-state.json", state("local-only")]]);
  const io: NetworkAccessIo = {
    read: async (p) => { const v = files.get(p); if (v === undefined) throw new Error("ENOENT"); return v; },
    write: async (p, t) => { files.set(p, t); },
    rename: async (a, b) => { files.set(b, files.get(a)!); files.delete(a); },
  };
  let ticks = 0;
  const access = createNetworkAccess({ dir: "/b", io, id: () => "r1", wait: async () => {
    ticks++;
    if (ticks === 2) {
      const req = JSON.parse(files.get("/b/exposure-request.json")!);
      expect(req).toEqual({ id: "r1", mode: "network-accessible" });
      files.set("/b/exposure-state.json", state("network-accessible", { lastResult: { id: "r1", ok: true } }));
    }
  } });
  await access.refresh();
  expect(access.snapshot()?.serverExposureState.mode).toBe("local-only");
  const next = await access.setServerExposureMode("network-accessible");
  expect(next.serverExposureState.mode).toBe("network-accessible");
});

test("a refused request throws the launcher's message", async () => {
  const files = new Map<string, string>([["/b/exposure-state.json", state("local-only")]]);
  const io: NetworkAccessIo = { read: async (p) => files.get(p) ?? "", write: async (p, t) => { files.set(p, t); }, rename: async (a, b) => { files.set(b, files.get(a)!); } };
  const access = createNetworkAccess({ dir: "/b", io, id: () => "r2", wait: async () => { files.set("/b/exposure-state.json", state("local-only", { lastResult: { id: "r2", ok: false, error: "Tailscale is not installed." } })); } });
  await expect(access.setTailscaleServeEnabled({ enabled: true, port: 443 })).rejects.toThrow("Tailscale is not installed.");
  expect(parseSnapshot("{}")).toBe(null);
});
