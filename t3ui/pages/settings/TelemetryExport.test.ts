import { expect, test } from "nsh/test";
import { SIGNALS, endpointStatus, isHttpUrl, runningOverride } from "./telemetryExportLogic";

test("an endpoint the environment sets wins and says what set it", () => {
  const running = { otlpTracesUrl: "http://collector:4318/v1/traces", otlpTracesSource: "environment", otlpTracesVariable: "T3CODE_OTLP_TRACES_URL", otlpMetricsUrl: "http://m", otlpMetricsSource: "settings" };
  expect(runningOverride(running, SIGNALS[0])).toEqual({ url: "http://collector:4318/v1/traces", label: "Set by environment", variable: "T3CODE_OTLP_TRACES_URL" });
  expect(runningOverride(running, SIGNALS[1])).toBeUndefined();
  expect(runningOverride({ otlpLogsUrl: "http://l", otlpLogsSource: "bootstrap" }, SIGNALS[2])?.label).toBe("Set by desktop");
  expect(runningOverride(null, SIGNALS[0])).toBeUndefined();
});

test("a checked endpoint reads Off, Not checked, Checking, Connected, Rejected or Unreachable", () => {
  const url = "http://localhost:4318/v1/logs";
  expect(isHttpUrl(url)).toBe(true);
  expect(isHttpUrl("localhost")).toBe(false);
  expect(endpointStatus("", undefined).label).toBe("Off");
  expect(endpointStatus(url, undefined).label).toBe("Not checked");
  expect(endpointStatus(url, { url: "http://other", result: null }).label).toBe("Not checked");
  expect(endpointStatus(url, { url, result: null })).toEqual({ label: "Checking…", dot: "bg-warning" });
  expect(endpointStatus(url, { url, result: { _tag: "Accepted", latencyMs: 12.4 } })).toEqual({ label: "Connected · 12 ms", dot: "bg-success" });
  expect(endpointStatus(url, { url, result: { _tag: "Rejected", status: 401 } }).label).toBe("Rejected · HTTP 401");
  expect(endpointStatus(url, { url, result: { _tag: "Unreachable", timedOut: true } }).label).toBe("Timed out");
  expect(endpointStatus(url, { url, result: { _tag: "Unreachable", timedOut: false } }).label).toBe("Unreachable");
});
