import { expect, test } from "nsh/test";
import { configureDesktop, type DesktopChildProcess } from "./runtime";
import { startMacModifierPairShortcutProcess } from "./snapShotModifierPoller";

interface FakeChild extends DesktopChildProcess {
  emit(stream: "stdout" | "stderr", line: string): void;
  exit(code: number | null): void;
  killed: boolean;
}

let nextChild: () => FakeChild = () => makeChild();
const spawnCalls: string[][] = [];

function makeChild(): FakeChild {
  const lineHandlers: Record<string, ((line: string) => void)[]> = { stdout: [], stderr: [] };
  const exitHandlers: ((result: { code: number | null; signal: string | null }) => void)[] = [];
  const child: FakeChild = {
    killed: false,
    onLine: (stream, handler) => { lineHandlers[stream]!.push(handler); },
    onExit: (handler) => { exitHandlers.push(handler); },
    kill: () => { child.killed = true; },
    emit: (stream, line) => { for (const handler of lineHandlers[stream]!) handler(line); },
    exit: (code) => { for (const handler of exitHandlers) handler({ code, signal: null }); },
  };
  return child;
}

configureDesktop({
  spawn: (command, args) => {
    spawnCalls.push([command, ...args]);
    return nextChild();
  },
});

test("resolves a stop function once the poller reports ready on stderr (JXA's console.log), and stop kills it", async () => {
  spawnCalls.length = 0;
  const child = makeChild();
  nextChild = () => child;
  const started = startMacModifierPairShortcutProcess("shift", () => {}, () => {});
  child.emit("stderr", "ready");
  const stop = await started;
  expect(spawnCalls[0]!.slice(0, 3)).toEqual(["/usr/bin/osascript", "-l", "JavaScript"]);
  expect(spawnCalls[0]!.slice(-2)).toEqual(["2", "4"]);
  expect(child.killed).toBe(false);
  stop();
  expect(child.killed).toBe(true);
});

test("a trigger line fires onTrigger only after ready, and only once per line", async () => {
  const child = makeChild();
  nextChild = () => child;
  const triggers: number[] = [];
  const started = startMacModifierPairShortcutProcess("meta", () => { triggers.push(triggers.length); }, () => {});
  child.emit("stderr", "trigger"); // ignored: not ready yet
  child.emit("stderr", "ready");
  await started;
  child.emit("stderr", "trigger");
  child.emit("stderr", "trigger");
  expect(triggers).toEqual([0, 1]);
});

test("exiting before ready rejects the start promise", async () => {
  const child = makeChild();
  nextChild = () => child;
  const started = startMacModifierPairShortcutProcess("control", () => {}, () => {});
  child.exit(1);
  await expect(started).rejects.toThrow();
});

test("exiting after ready calls onFailure instead of rejecting", async () => {
  const child = makeChild();
  nextChild = () => child;
  const failures: string[] = [];
  const started = startMacModifierPairShortcutProcess("alt", () => {}, (error) => failures.push(error.message));
  child.emit("stderr", "ready");
  await started;
  child.exit(2);
  expect(failures).toEqual(["Snapshot shortcut helper exited with code 2"]);
});
