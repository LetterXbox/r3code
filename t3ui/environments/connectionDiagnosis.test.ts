import { expect, test } from "nsh/test";
import { classifyConnectionFailure, connectionDiagnosisText, presentConnectionDiagnosis, type SupervisorConnectionState } from "./connectionDiagnosis";

const state = (lastFailure: SupervisorConnectionState["lastFailure"], extra: Partial<SupervisorConnectionState> = {}): SupervisorConnectionState => ({ network: "unknown", phase: "backoff", attempt: 3, lastFailure, retryAt: null, ...extra });

test("nothing failed means no diagnosis", () => {
  expect(presentConnectionDiagnosis({ hostLabel: "Mac", state: state(null), via: "direct" })).toBe(null);
});

test("a direct network failure guesses T3 Code on the host, leaves the device unchecked and names the steps", () => {
  const diagnosis = presentConnectionDiagnosis({ hostLabel: "Mac", state: state(classifyConnectionFailure(new Error("fetch failed"))), via: "direct", serverVersion: "1.2.3" })!;
  expect(diagnosis.headline).toBe("T3 Code on Mac did not answer");
  expect(diagnosis.hops).toEqual([{ hop: "device", label: "This device", result: "unchecked" }, { hop: "server", label: "T3 Code on Mac", result: "failed" }]);
  expect(diagnosis.steps).toEqual(["Make sure T3 Code is running on Mac.", "Retry. If it keeps failing, copy the diagnostics."]);
  expect(diagnosis.moreInfoUrl).toBe(null);
  expect(diagnosis.facts).toEqual([["Cause", "network"], ["Attempts", "3"], ["Route", "Direct"], ["Host version", "1.2.3"], ["Error", "fetch failed"]]);
});

test("a refused session is blocked on the server hop, with the device checked", () => {
  const failure = classifyConnectionFailure(Object.assign(new Error("Environment authorization failed (HTTP 401)"), { traceId: "abc" }));
  expect(failure).toMatchObject({ _tag: "ConnectionBlockedError", reason: "authentication", hop: "server", httpStatus: 401, traceId: "abc" });
  const diagnosis = presentConnectionDiagnosis({ hostLabel: "Mac", state: state(failure, { phase: "blocked" }), via: "direct" })!;
  expect(diagnosis.headline).toBe("T3 Code on Mac did not accept this device");
  expect(diagnosis.hops.map((hop) => hop.result)).toEqual(["ok", "failed"]);
  expect(connectionDiagnosisText("Mac", diagnosis).split("\n").slice(0, 4)).toEqual(["T3 Code connection to Mac: T3 Code on Mac did not accept this device", "", "This device: ok", "T3 Code on Mac: FAILED"]);
});

test("an offline device and a relay tunnel failure follow the reference's hops and help links", () => {
  expect(presentConnectionDiagnosis({ hostLabel: "Mac", state: state(null, { network: "offline" }), via: "direct" })!.headline).toBe("This device is offline");
  const relay = presentConnectionDiagnosis({ hostLabel: "Mac", state: state({ _tag: "ConnectionTransientError", reason: "network", detail: "x", via: "relay" }), via: "relay" })!;
  expect(relay.headline).toBe("This device can't reach Mac's tunnel");
  expect(relay.hops.map((hop) => hop.label)).toEqual(["This device", "T3 Connect", "Mac tunnel", "T3 Code on Mac"]);
  expect(relay.moreInfoUrl).toBe("https://github.com/pingdotgg/t3code/blob/main/docs/user/t3-connect-troubleshooting.md#this-device-cant-reach-t3-connect");
});
