import { expect, test } from "nsh/test";
import { configureDesktop, type DesktopChildProcess } from "./../desktop/runtime";
import { saveSnapShotSettings } from "../desktop/snapShot";
import { boundSnapShotKeystroke, installSnapShotShortcut, snapShotShortcutSuppressed } from "./snapShotShortcut";

const storage = new Map<string, string>();
const contents = new Map<string, Uint8Array>();
const spawnCalls: string[][] = [];
let currentChild: { stderrHandlers: ((line: string) => void)[]; killed: boolean } | null = null;

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

configureDesktop({
  os: () => "macos",
  dataDir: () => "/data",
  randomId: () => "abc",
  getItem: async (key) => storage.get(key) ?? null,
  setItem: async (key, value) => { storage.set(key, value); },
  mkdir: async () => undefined,
  writeFile: async (path, data) => { contents.set(path, toBytes(data)); },
  readFile: async (path) => { const data = contents.get(path); if (!data) throw new Error("ENOENT"); return data; },
  rename: async (from, to) => { const data = contents.get(from); if (data) { contents.delete(from); contents.set(to, data); } },
  readdir: async (dir) => [...contents.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1)),
  unlink: async (path) => { contents.delete(path); },
  fileSize: async (path) => (contents.has(path) ? contents.get(path)!.length : null),
  spawn: (command, args): DesktopChildProcess => {
    spawnCalls.push([command, ...args]);
    const stderrHandlers: ((line: string) => void)[] = [];
    const child = { stderrHandlers, killed: false };
    currentChild = child;
    queueMicrotask(() => { for (const handler of stderrHandlers) handler("ready"); });
    return {
      onLine: (stream, handler) => { if (stream === "stderr") stderrHandlers.push(handler); },
      onExit: () => undefined,
      kill: () => { child.killed = true; },
    };
  },
});

const settle = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

test("the default modifier-pair shortcut starts the osascript poller, and a trigger runs the capture", async () => {
  storage.clear();
  contents.clear();
  spawnCalls.length = 0;
  currentChild = null;
  const captures: number[] = [];
  installSnapShotShortcut(() => { captures.push(captures.length); });
  await saveSnapShotSettings({ snapShotEnabled: true });
  await settle();

  expect(spawnCalls.length > 0).toBe(true);
  expect(spawnCalls[0]!.slice(0, 3)).toEqual(["/usr/bin/osascript", "-l", "JavaScript"]);
  expect(boundSnapShotKeystroke()).toBe(null); // a modifier pair never binds a keymap keystroke

  currentChild!.stderrHandlers.forEach((handler) => handler("trigger"));
  expect(captures).toEqual([0]);

  snapShotShortcutSuppressed.set(true);
  await settle();
  expect(currentChild!.killed).toBe(true);
  snapShotShortcutSuppressed.set(false);
});

test("a key-chord shortcut binds in-app instead of starting the poller", async () => {
  storage.clear();
  contents.clear();
  spawnCalls.length = 0;
  await saveSnapShotSettings({ snapShotEnabled: true, snapShotShortcut: { key: "2", modKey: true, shiftKey: true, ctrlKey: false, altKey: false, metaKey: false } });
  installSnapShotShortcut(() => undefined);
  await settle();
  expect(boundSnapShotKeystroke()).toBe("mod+shift+2");
  expect(spawnCalls.length).toBe(0);
});
