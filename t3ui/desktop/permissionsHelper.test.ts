import { expect, test } from "nsh/test";
import { configureDesktop, type RunResult } from "./runtime";
import { MAC_ACCESSIBILITY_TRUSTED_SCRIPT } from "./snapShotActiveWindow";
import { openPermissionSettings, permissionsStatus, recheckPermission } from "./permissionsHelper";

const storage = new Map<string, string>();
const files = new Map<string, number>();
const opened: string[] = [];
let trusted = false;
let captureAnswer: () => RunResult = () => ({ code: 0, stdout: "", stderr: "" });

configureDesktop({
  os: () => "macos",
  dataDir: () => "/data",
  now: () => new Date("2026-01-02T03:04:05.000Z"),
  randomId: () => "abc",
  mkdir: async () => undefined,
  writeFile: async () => undefined,
  unlink: async (path) => { files.delete(path); },
  fileSize: async (path) => files.get(path) ?? null,
  openUrl: async (url) => { opened.push(url); return true; },
  getItem: async (key) => storage.get(key) ?? null,
  setItem: async (key, value) => { storage.set(key, value); },
  run: async (command, args) => {
    if (command === "/usr/bin/osascript") return { code: 0, stdout: args[3] === MAC_ACCESSIBILITY_TRUSTED_SCRIPT ? String(trusted) : "", stderr: "" };
    const result = captureAnswer();
    if (result.stdout.length || result.code !== 0) { /* screencapture itself: fall through */ }
    files.set("/data/snapshots/" + args[args.length - 1].split("/").pop(), result.code === 0 ? 10 : 0);
    return result;
  },
});

test("status composes Accessibility (osascript) with Screen Recording's own storage key", async () => {
  trusted = true;
  storage.set("t3code:snap-shot-screen-recording:v1", "granted");
  expect(await permissionsStatus()).toEqual({ accessibility: "granted", screenRecording: "granted" });

  trusted = false;
  storage.delete("t3code:snap-shot-screen-recording:v1");
  expect(await permissionsStatus()).toEqual({ accessibility: "denied", screenRecording: "unknown" });
});

test("openPermissionSettings opens the matching System Settings pane", async () => {
  await openPermissionSettings("accessibility");
  expect(opened).toContain("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  await openPermissionSettings("screen-recording");
  expect(opened).toContain("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
});

test("recheckPermission re-reads Accessibility at once, and runs a test capture for Screen Recording", async () => {
  trusted = true;
  expect(await recheckPermission("accessibility")).toBe("granted");
  trusted = false;
  expect(await recheckPermission("accessibility")).toBe("denied");

  captureAnswer = () => ({ code: 0, stdout: "", stderr: "" });
  expect(await recheckPermission("screen-recording")).toBe("granted");

  captureAnswer = () => ({ code: 0, stdout: "", stderr: "could not create image" });
  expect(await recheckPermission("screen-recording")).toBe("denied");
});
