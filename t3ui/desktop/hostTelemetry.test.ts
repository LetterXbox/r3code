import { expect, test } from "nsh/test";
import {
  buildHostTelemetryMessage, idleTriState, parseIoregIdleSeconds, parsePmsetBattery, parsePmsetThermal, sampleHostPower,
  publishHostTelemetry, publishHostTelemetryOnce, startHostTelemetryPublisher, TELEMETRY_SAMPLE_FILE, type TelemetryIo, type HostPowerSample,
} from "./hostTelemetry";
import { configureDesktop } from "./runtime";

test("parsePmsetBattery reads AC vs. battery power, and 'unknown' for anything else", () => {
  expect(parsePmsetBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=123)\t100%; charged;")).toBe("false");
  expect(parsePmsetBattery("Now drawing from 'Battery Power'\n -InternalBattery-0\t82%; discharging;")).toBe("true");
  expect(parsePmsetBattery("")).toBe("unknown");
});

test("parsePmsetThermal buckets CPU_Speed_Limit into the reference's thermal states", () => {
  expect(parsePmsetThermal("CPU_Scheduler_Limit\t= 100\nCPU_Speed_Limit\t= 100\n")).toBe("nominal");
  expect(parsePmsetThermal("CPU_Speed_Limit\t= 85\n")).toBe("fair");
  expect(parsePmsetThermal("CPU_Speed_Limit\t= 60\n")).toBe("serious");
  expect(parsePmsetThermal("CPU_Speed_Limit\t= 20\n")).toBe("critical");
  expect(parsePmsetThermal("no such field")).toBe("unknown");
});

test("parseIoregIdleSeconds converts HIDIdleTime nanoseconds to seconds", () => {
  expect(parseIoregIdleSeconds('"HIDIdleTime" = 5000000000')).toBe(5);
  expect(parseIoregIdleSeconds("nothing here")).toBeNull();
});

test("idleTriState applies the reference's 60s threshold", () => {
  expect(idleTriState(59)).toBe("false");
  expect(idleTriState(60)).toBe("true");
  expect(idleTriState(null)).toBe("unknown");
});

configureDesktop({
  run: async (command) => {
    if (command === "/usr/bin/pmset") throw new Error("not macOS");
    return { code: 0, stdout: '"HIDIdleTime" = 120000000000', stderr: "" };
  },
});

test("sampleHostPower degrades a failing command to unknown/null instead of throwing", async () => {
  const sample = await sampleHostPower();
  expect(sample.onBattery).toBe("unknown");
  expect(sample.thermalState).toBe("unknown");
  expect(sample.idleSeconds).toBe(120);
});

test("buildHostTelemetryMessage matches the shape server-rs/background_activity.rs validates", () => {
  const message = buildHostTelemetryMessage(
    { onBattery: "true", thermalState: "fair", idleSeconds: 42 },
    { sequence: 7, hostPid: 4242, sampledAt: new Date("2024-01-01T00:00:00.000Z") },
  );
  expect(message.version).toBe(1);
  expect(message.type).toBe("desktopTelemetry");
  expect(message.sequence).toBe(7);
  expect(message.electronPid).toBe(4242);
  expect(message.power.source).toBe("node-macos-shell");
  expect(message.power.idle).toBe("false"); // 42s < the 60s idle threshold.
  expect(message.power.onBattery).toBe("true");
  expect(message.power.thermalState).toBe("fair");
  expect(Array.isArray(message.electronProcesses)).toBe(true);
});

const sample: HostPowerSample = { onBattery: "false", thermalState: "nominal", idleSeconds: 3 };

test("publishHostTelemetry without a launcher directory writes nothing and reports false", async () => {
  const io: TelemetryIo = { write: async () => { throw new Error("should not be called"); }, rename: async () => { throw new Error("should not be called"); } };
  expect(await publishHostTelemetry(sample, { dir: null, io })).toBe(false);
});

test("publishHostTelemetry writes the full wire message atomically (tmp then rename)", async () => {
  const files = new Map<string, string>();
  const io: TelemetryIo = {
    write: async (p, t) => { files.set(p, t); },
    rename: async (a, b) => { files.set(b, files.get(a)!); files.delete(a); },
  };
  const ok = await publishHostTelemetry(sample, { dir: "/b", io });
  expect(ok).toBe(true);
  expect(files.has(`/b/${TELEMETRY_SAMPLE_FILE}.tmp`)).toBe(false);
  const written = JSON.parse(files.get(`/b/${TELEMETRY_SAMPLE_FILE}`)!);
  expect(written.type).toBe("desktopTelemetry");
  expect(written.power.onBattery).toBe("false");
  expect(written.power.thermalState).toBe("nominal");
});

test("publishHostTelemetryOnce samples then publishes, and never throws on a write failure", async () => {
  const files = new Map<string, string>();
  const io: TelemetryIo = {
    write: async (p, t) => { files.set(p, t); },
    rename: async (a, b) => { files.set(b, files.get(a)!); files.delete(a); },
  };
  let errored: unknown;
  await publishHostTelemetryOnce({ dir: "/b", io, sample: async () => sample, onError: (e) => { errored = e; } });
  expect(files.has(`/b/${TELEMETRY_SAMPLE_FILE}`)).toBe(true);
  expect(errored).toBeUndefined();

  const failing: TelemetryIo = { write: async () => { throw new Error("disk full"); }, rename: io.rename };
  await publishHostTelemetryOnce({ dir: "/b", io: failing, sample: async () => sample, onError: (e) => { errored = e; } });
  expect(errored).toBeTruthy();
  expect((errored as Error).message).toBe("disk full");
});

test("startHostTelemetryPublisher samples immediately, then on every tick, until stopped", async () => {
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const files = new Map<string, string>();
  const io: TelemetryIo = {
    write: async (p, t) => { files.set(p, t); },
    rename: async (a, b) => { files.set(b, files.get(a)!); files.delete(a); },
  };
  const ticks: (() => void)[] = [];
  let calls = 0;
  const handle = startHostTelemetryPublisher({
    dir: "/b", io, sample: async () => { calls += 1; return sample; },
    setInterval: (fn) => { ticks.push(fn as () => void); return ticks.length; },
    clearInterval: () => {},
  });
  await flush();
  expect(calls).toBe(1); // sampled immediately, not only on the first tick.
  ticks[0]();
  await flush();
  expect(calls).toBe(2);
  handle.stop();
  expect(files.has(`/b/${TELEMETRY_SAMPLE_FILE}`)).toBe(true);
});
