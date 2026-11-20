import { expect, test } from "nsh/test";
import { configureDesktop, type DesktopChildProcess, type RunResult } from "./runtime";
import { captureWindow, checkSnapShotShortcut, getSnapShotState, MAC_ACCESSIBILITY_PERMISSION_MESSAGE, MAC_BOTH_PERMISSIONS_MESSAGE, MAC_SCREEN_CAPTURE_PERMISSION_MESSAGE, macPermissionMessage, saveSnapShotSettings, setupSnapShot, testMacCapture } from "./snapShot";
import { MAC_ACCESSIBILITY_TRUSTED_SCRIPT, pickActiveWindow } from "./snapShotActiveWindow";
import { captureSnapShotToDraft, configureSnapShotCapture } from "./snapShotCapture";
import { snapShotSourceFor } from "./snapShotSource";
import { chordFromKeystroke, formatSnapShotShortcutLabel, snapShotKeystroke } from "./snapShotShortcut";

const calls: string[] = [];
const opened: string[] = [];
const files = new Map<string, number>();
const contents = new Map<string, Uint8Array>();
const storage = new Map<string, string>();
let answer: (args: string[]) => RunResult = () => ({ code: 0, stdout: "", stderr: "" });
// osascript (the frontmost-window lookup, the Accessibility check): kept apart from the screencapture calls.
let trusted = false;
let frontmost = "";
const osaCalls: string[][] = [];
const spawnCalls: string[][] = [];
/** The modifier-pair poller's fake child (snapShotModifierPoller.test.ts covers the handshake itself; here it
 * only needs to answer "ready" so checkSnapShotShortcut / installSnapShotShortcut never hang or touch a real
 * process). */
let nextSpawnReady = true;

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

configureDesktop({
  os: () => "macos",
  dataDir: () => "/data",
  now: () => new Date("2026-01-02T03:04:05.000Z"),
  randomId: () => "abc",
  mkdir: async () => undefined,
  writeFile: async (path, data) => { contents.set(path, toBytes(data)); },
  readFile: async (path) => { const data = contents.get(path); if (!data) throw new Error("ENOENT"); return data; },
  rename: async (from, to) => { const data = contents.get(from); if (data) { contents.delete(from); contents.set(to, data); } },
  readdir: async (dir) => [...contents.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1)),
  unlink: async (path) => { files.delete(path); contents.delete(path); },
  fileSize: async (path) => files.get(path) ?? null,
  openUrl: async (url) => { opened.push(url); return true; },
  getItem: async (key) => storage.get(key) ?? null,
  setItem: async (key, value) => { storage.set(key, value); },
  run: async (command, args) => {
    if (command === "/usr/bin/osascript") {
      osaCalls.push(args);
      return { code: 0, stdout: args[3] === MAC_ACCESSIBILITY_TRUSTED_SCRIPT ? String(trusted) : frontmost, stderr: "" };
    }
    calls.push([command, ...args].join(" "));
    return answer(args);
  },
  spawn: (command, args): DesktopChildProcess => {
    spawnCalls.push([command, ...args]);
    const stderrHandlers: ((line: string) => void)[] = [];
    const exitHandlers: ((result: { code: number | null; signal: string | null }) => void)[] = [];
    if (nextSpawnReady) queueMicrotask(() => { for (const handler of stderrHandlers) handler("ready"); });
    else queueMicrotask(() => { for (const handler of exitHandlers) handler({ code: 1, signal: null }); });
    return {
      onLine: (stream, handler) => { if (stream === "stderr") stderrHandlers.push(handler); },
      onExit: (handler) => { exitHandlers.push(handler); },
      kill: () => undefined,
    };
  },
});

const reset = () => { calls.length = 0; opened.length = 0; osaCalls.length = 0; spawnCalls.length = 0; files.clear(); contents.clear(); storage.clear(); trusted = false; frontmost = ""; nextSpawnReady = true; };

test("interactive window capture runs screencapture with the exact arguments and returns the file", async () => {
  reset();
  answer = (args) => { files.set(args[args.length - 1]!, 1234); return { code: 0, stdout: "", stderr: "" }; };
  const result = await captureWindow();
  expect(calls).toEqual(["/usr/sbin/screencapture -i -w -o -x -t png /data/snapshots/window-2026-01-02T03-04-05.000Z.png"]);
  expect(result).toEqual({ status: "captured", path: "/data/snapshots/window-2026-01-02T03-04-05.000Z.png", sizeBytes: 1234, capturedAt: "2026-01-02T03:04:05.000Z" });
});

test("Escape during the pick is a silent cancel", async () => {
  reset();
  answer = () => ({ code: 1, stdout: "", stderr: "" });
  expect((await captureWindow()).status).toBe("cancelled");
});

test("could not create image means Screen Recording is denied, and the state says so", async () => {
  reset();
  answer = () => ({ code: 1, stdout: "", stderr: "could not create image from display" });
  expect(await captureWindow()).toEqual({ status: "denied", message: MAC_SCREEN_CAPTURE_PERMISSION_MESSAGE });
  await saveSnapShotSettings({ snapShotEnabled: true });
  const state = await getSnapShotState();
  expect(state.macPermissions).toEqual({ screenRecording: false, accessibility: false });
  // snapShotIncludeAccessibility is on by default, so both are asked for (macPermissionMessage).
  expect(state.message).toBe(MAC_BOTH_PERMISSIONS_MESSAGE);
});

test("Allow Screen Recording runs a 1x1 test capture and opens System Settings when denied", async () => {
  reset();
  answer = () => ({ code: 1, stdout: "", stderr: "could not create image" });
  await setupSnapShot("allow-screen-recording");
  expect(calls).toEqual(["/usr/sbin/screencapture -x -R0,0,1,1 -t png /data/snapshots/test-abc.png"]);
  expect(opened).toEqual(["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"]);
});

test("a successful test capture grants Screen Recording and discards the image", async () => {
  reset();
  answer = (args) => { files.set(args[args.length - 1]!, 10); return { code: 0, stdout: "", stderr: "" }; };
  expect((await testMacCapture()).status).toBe("captured");
  expect(files.size).toBe(0);
  await saveSnapShotSettings({ snapShotEnabled: true, snapShotShortcut: { key: "2", modKey: true, shiftKey: true, ctrlKey: false, altKey: false, metaKey: false } });
  expect((await getSnapShotState()).message).toBe(MAC_ACCESSIBILITY_PERMISSION_MESSAGE);
  trusted = true;
  const state = await getSnapShotState();
  expect(state.macPermissions).toEqual({ screenRecording: true, accessibility: true });
  expect(state.shortcutRegistered).toBe(true);
  expect(state.message).toBe(null);
});

test("Allow Accessibility opens its Privacy pane", async () => {
  reset();
  await setupSnapShot("allow-accessibility");
  expect(opened).toEqual(["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]);
});

test("Shift + Shift cannot be bound in-app (keymap cannot bind a modifier alone), but the osascript poller can observe it", async () => {
  reset();
  expect(snapShotKeystroke({ kind: "both-shift-keys" })).toBe(null);
  expect(formatSnapShotShortcutLabel({ kind: "both-shift-keys" })).toBe("Shift + Shift");
  // checkSnapShotShortcut actually starts the poller (and stops it again) to probe this, as DesktopSnapShot.ts's
  // own checkShortcut does, instead of always reporting a modifier pair unavailable.
  expect(await checkSnapShotShortcut({ kind: "both-shift-keys" })).toEqual({ available: true, message: "Shift + Shift is observed and cannot be reserved exclusively." });
  expect(spawnCalls[0]!.slice(0, 3)).toEqual(["/usr/bin/osascript", "-l", "JavaScript"]);

  nextSpawnReady = false;
  expect(await checkSnapShotShortcut({ kind: "both-shift-keys" })).toEqual({ available: false, message: "Shift + Shift is not available on this system." });
});

test("chords round-trip between keymap keystrokes and the contract shape", () => {
  const chord = chordFromKeystroke("mod+shift+2")!;
  expect(chord).toEqual({ key: "2", modKey: true, shiftKey: true, ctrlKey: false, altKey: false, metaKey: false });
  expect(snapShotKeystroke(chord)).toBe("mod+shift+2");
  expect(formatSnapShotShortcutLabel(chord)).toBe("⇧⌘2");
  expect(chordFromKeystroke("k")).toBe(null);
});

test("capture to draft: the PNG goes through the composer intake and the temp file is removed", async () => {
  reset();
  const attached: string[] = [];
  const toasts: string[] = [];
  const sources: unknown[] = [];
  files.set("/data/snapshots/w.png", 5);
  configureSnapShotCapture({
    capture: async () => ({ status: "captured", path: "/data/snapshots/w.png", sizeBytes: 5, capturedAt: "x" }),
    attach: async (path, extra) => { attached.push(path); sources.push(extra?.source); },
    imageSize: async () => null,
    playSound: async () => undefined,
    probe: async () => ({ appName: "Notes", windowTitle: "Todo" }),
    toast: (input) => { toasts.push(input.title); return "t"; },
  });
  await saveSnapShotSettings({ snapShotEnabled: true });
  expect(await captureSnapShotToDraft()).toBe("attached");
  expect(attached).toEqual(["/data/snapshots/w.png"]);
  // deliverSnapShot: the window's source goes with the image (ChatImageAttachment.source).
  expect(sources).toEqual([{ kind: "snap-shot", capturedAt: "x", appName: "Notes", windowTitle: "Todo" }]);
  await Promise.resolve();
  // snapShotSource.ts: the probe's answer is kept for the capture's tile (SnapShotAttachmentDetails).
  expect(snapShotSourceFor("w.png")?.windowTitle).toBe("Todo");
  expect(files.has("/data/snapshots/w.png")).toBe(false);
  expect(toasts).toEqual([]);

  configureSnapShotCapture({ attach: async () => { throw new Error("Open a thread before attaching a file"); } });
  expect(await captureSnapShotToDraft()).toBe("failed");
  expect(toasts).toEqual(["Snapshot taken, but no project is available"]);

  configureSnapShotCapture({ capture: async () => ({ status: "denied", message: MAC_SCREEN_CAPTURE_PERMISSION_MESSAGE }) });
  expect(await captureSnapShotToDraft()).toBe("denied");
  expect(toasts[toasts.length - 1]).toBe("Snapshot failed");
});

test("macPermissionMessage follows the reference's order", () => {
  expect(macPermissionMessage({ screenRecording: true, accessibility: true }, true)).toBe(null);
  expect(macPermissionMessage({ screenRecording: true, accessibility: false }, false)).toBe(null);
  expect(macPermissionMessage({ screenRecording: false, accessibility: false }, false)).toBe(MAC_SCREEN_CAPTURE_PERMISSION_MESSAGE);
  expect(macPermissionMessage({ screenRecording: true, accessibility: false }, true)).toBe(MAC_ACCESSIBILITY_PERMISSION_MESSAGE);
});

const lookup = (windows: unknown[], self = false) => JSON.stringify({ owner: { name: "Notes", processId: 42, path: "/Applications/Notes.app", bundleId: "com.apple.Notes" }, self, windows });
const win = (id: number, title: string, x: number, y: number, width: number, height: number, alpha = 1) => ({ id, title, bounds: { x, y, width, height }, alpha });

test("the frontmost window: the reference's pick skips hidden windows and thin helper strips", () => {
  expect(pickActiveWindow("")).toBe(undefined);
  expect(pickActiveWindow(lookup([win(1, "Doc", 0, 0, 800, 600)], true))).toBe("self");
  // An invisible window, then an untitled 800x40 strip on top of the 800x600 window below it: the window wins.
  const picked = pickActiveWindow(lookup([win(5, "", 0, 0, 100, 100, 0), win(6, "", 0, 0, 800, 40), win(7, "", 0, 20, 800, 600)]));
  expect(picked).toEqual({ platform: "macos", id: 7, title: "", bounds: { x: 0, y: 20, width: 800, height: 600 }, owner: { name: "Notes", processId: 42, path: "/Applications/Notes.app", bundleId: "com.apple.Notes" } });
  expect((pickActiveWindow(lookup([win(8, "", 0, 0, 800, 40), win(9, "Todo", 0, 20, 800, 600)])) as { id: number }).id).toBe(9);
});

test("a frontmost window of another app is captured by id; the probe then reads that window", async () => {
  reset();
  frontmost = lookup([win(77, "Todo", 10, 20, 800, 600)]);
  answer = (args) => { files.set(args[args.length - 1]!, 99); return { code: 0, stdout: "", stderr: "" }; };
  const result = await captureWindow();
  expect(calls).toEqual(["/usr/sbin/screencapture -l 77 -o -x -t png /data/snapshots/window-2026-01-02T03-04-05.000Z.png"]);
  expect(result.status).toBe("captured");
  const { lastCapturedWindow } = await import("./snapShot");
  expect(lastCapturedWindow?.id).toBe(77);
  // R3 Code in front (the in-app shortcut): the user picks the window.
  reset();
  frontmost = lookup([win(1, "R3 Code", 0, 0, 800, 600)], true);
  answer = (args) => { files.set(args[args.length - 1]!, 1); return { code: 0, stdout: "", stderr: "" }; };
  await captureWindow();
  expect(calls[0]).toContain("screencapture -i -w");
});
