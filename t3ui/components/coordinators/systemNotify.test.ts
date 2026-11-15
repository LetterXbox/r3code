import { expect, test } from "nsh/test";
import { playNotificationSound } from "./systemNotify";

test("fm13: a burst of the same sound plays once; the other sound has its own slot", async () => {
  const calls: string[] = [];
  let finish: () => void = () => {};
  const runner = (_command: string, args: string[]) => { calls.push(args[0]!); return new Promise<void>((resolve) => { finish = resolve; }); };
  const first = playNotificationSound("completion", runner);
  expect(await playNotificationSound("completion", runner)).toBe(false);
  void playNotificationSound("input", runner);
  expect(calls.length).toBe(2);
  finish();
  void first;
});
