import { expect, test } from "nsh/test";
import {
  CLIENT_APP_VERSION,
  CONNECTION_NOTICE_ID,
  connectionNotice,
  connectionPhase,
  connectionPhaseDotClassName,
  connectionPhasePings,
  isAuthRefused,
  resolveVersionMismatch,
} from "./connection.logic";

test("a connection that was up and went down is reconnecting; the first connect is connecting", () => {
  expect(connectionPhase("connecting", false)).toBe("connecting");
  expect(connectionPhase("connecting", true)).toBe("reconnecting");
  expect(connectionPhase("connected", true)).toBe("connected");
  expect(connectionPhase("error", true)).toBe("error");
  expect(connectionPhase("disconnected", false)).toBe("disconnected");
});

test("the status dot follows the web's colours and pings while connecting", () => {
  expect(connectionPhaseDotClassName("connected")).toBe("bg-success");
  expect(connectionPhaseDotClassName("reconnecting")).toBe("bg-warning");
  expect(connectionPhaseDotClassName("error")).toBe("bg-destructive");
  expect(connectionPhasePings("connecting")).toBe(true);
  expect(connectionPhasePings("connected")).toBe(false);
});

test("a reconnect is only worth a warning once it has held for the grace period", () => {
  const base = { phase: "reconnecting" as const, label: "legion", error: null, hasSession: true };
  expect(connectionNotice({ ...base, graceElapsed: false })).toBe(null);
  expect(connectionNotice({ ...base, graceElapsed: true })).toEqual({ id: CONNECTION_NOTICE_ID, variant: "warning", title: "legion is reconnecting", action: null });
});

test("a failed connection with a session says offline and offers Reconnect", () => {
  expect(connectionNotice({ phase: "error", label: "legion", error: "WebSocket closed", graceElapsed: false, hasSession: true })).toEqual({
    id: CONNECTION_NOTICE_ID, variant: "error", title: "legion is offline", description: "WebSocket closed", action: "Reconnect",
  });
  // Nothing to resume without a session: the thread view's "Connect an environment" is the way in.
  expect(connectionNotice({ phase: "error", label: "legion", error: "x", graceElapsed: true, hasSession: false })).toBe(null);
  expect(connectionNotice({ phase: "disconnected", label: "legion", error: null, graceElapsed: true, hasSession: true })).toBe(null);
  expect(connectionNotice({ phase: "connected", label: "legion", error: null, graceElapsed: true, hasSession: true })).toBe(null);
});

test("a refused session asks to pair again instead of retrying", () => {
  const error = "Environment authorization expired. Enter a new pairing token.";
  expect(isAuthRefused(error)).toBe(true);
  expect(isAuthRefused("HTTP 500")).toBe(false);
  expect(connectionNotice({ phase: "error", label: "legion", error, graceElapsed: false, hasSession: false })).toEqual({
    id: CONNECTION_NOTICE_ID, variant: "error", title: "Pair with this environment", description: error, action: "Open Environments",
  });
});

test("a server behind the client is a version mismatch, a newer one is not", () => {
  expect(CLIENT_APP_VERSION).toBe("0.1.8");
  expect(resolveVersionMismatch("0.1.8")).toBe(null);
  expect(resolveVersionMismatch("0.2.0")).toBe(null);
  expect(resolveVersionMismatch("0.1.7")).toEqual({ clientVersion: "0.1.8", serverVersion: "0.1.7", hint: "Version mismatch. Try syncing the client and server to the same R3 Code version." });
  expect(resolveVersionMismatch("0.1.7", "0.1.8")?.serverVersion).toBe("0.1.7");
  expect(resolveVersionMismatch(undefined)).toBe(null);
  expect(resolveVersionMismatch("  ")).toBe(null);
});

test("builds compare by their core version, nightlies by their full version, and non-semver by equality", () => {
  expect(resolveVersionMismatch("0.1.8-beta.1", "0.1.8")).toBe(null);
  expect(resolveVersionMismatch("0.1.8-nightly.20260101", "0.1.8-nightly.20260102")).not.toBe(null);
  expect(resolveVersionMismatch("0.1.8-nightly.20260102", "0.1.8-nightly.20260101")).toBe(null);
  expect(resolveVersionMismatch("dev", "0.1.8")).not.toBe(null);
  expect(resolveVersionMismatch("dev", "dev")).toBe(null);
});
