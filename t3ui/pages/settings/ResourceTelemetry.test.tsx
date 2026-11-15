import { expect, open, test } from "nsh/test";
import { parseTelemetrySnapshot } from "./resourceTelemetryData";
import { formatBytes, shouldShowResourceMonitorRetry, visibleResourceTelemetryProcesses } from "./resourceTelemetryLogic";

test("bytes, retry rule and collapsed trees follow the reference logic", () => {
  expect(formatBytes(1023.6 * 1024)).toBe("1.00 MB");
  expect(formatBytes(512)).toBe("512 B");
  expect(shouldShowResourceMonitorRetry({ nativeStatus: "healthy", error: null })).toBe(false);
  expect(shouldShowResourceMonitorRetry({ nativeStatus: null, error: "x" })).toBe(true);
  expect(shouldShowResourceMonitorRetry({ nativeStatus: "stopped", error: null })).toBe(true);
  expect(() => parseTelemetrySnapshot({ readAt: "x" })).toThrow("Invalid diagnostics response.");
  const p = (pid: number, ppid: number) => ({ identity: { pid, startTimeMs: 0 }, ppid }) as never;
  expect(visibleResourceTelemetryProcesses([p(1, 0), p(2, 1), p(3, 2)], new Set(["1:0"])).length).toBe(1);
});

test("the five telemetry sections show the stream, history, host health, tree and I/O", async () => {
  const app = await open("./ResourceTelemetryFixture.tsx", { width: 1400, height: 3000 });
  await app.waitFor("text:Resource monitor");
  for (const t of ["Host & collection", "Resource timeline", "Live process tree", "Instrumented application I/O", "Sampling every 2 seconds", "12.5%", "2.00 MB/s", "70%", "T3 SYSTEM FOOTPRINT", "BACKEND + AGENTS", "MONITOR OVERHEAD",
    "Power source", "Battery", "DESKTOP ONLY", "Available when this page runs inside the desktop app.", "1.2.3 · PID 55", "1.50 ms", "3/40 retained", "Retry monitor",
    "t3-server", "codex", "sqlite", "1.50s", "sidecar exited"]) await expect(app.texts()).toContain(t);
  await app.waitFor("text:1.02m");
  await expect(app.texts()).toContain("9.5%");
});

test("INT signals a provider, KILL asks first, and Retry monitor restarts the collector", async () => {
  const app = await open("./ResourceTelemetryFixture.tsx", { width: 1400, height: 3000 });
  await app.waitFor("text:codex");
  await app.press("id:Process 101 >> label:Send SIGINT");
  await app.waitFor("text:server.signalProcess 101 SIGINT");
  await app.press("label:Deny kill");
  await app.press("id:Process 101 >> label:Send SIGKILL");
  await app.waitFor("text:confirm Send SIGKILL to process 101? This cannot be handled by the process.");
  await expect(app.texts()).not.toContain("server.signalProcess 101 SIGKILL");
  await app.press("label:Retry monitor");
  await app.waitFor("text:server.retryResourceTelemetry");
  await app.press("label:Collapse t3-server");
  await expect(app.texts()).not.toContain("INT");
});
