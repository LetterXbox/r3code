import { expect, test } from "nsh/test";
import { sendBackgroundApplies, sendInBackground } from "./sendBackground";
import type { BackgroundSendDeps } from "./sendBackground";

function harness(overrides: Partial<BackgroundSendDeps> = {}) {
  const calls: string[] = [];
  let toast: Parameters<BackgroundSendDeps["toast"]>[0] | null = null;
  const deps: BackgroundSendDeps = {
    threadId: () => "thread:a", projectId: () => "project-1", isDraft: () => true, canSend: () => true,
    submit: () => calls.push("submit"), isSending: () => true,
    newThread: (project) => calls.push(`new:${project}`), open: (id) => calls.push(`open:${id}`),
    toast: (input) => { toast = input; }, ...overrides,
  };
  return { deps, calls, toast: () => toast };
}

test("a draft thread is sent, a fresh composer opens, and the toast offers the started thread", () => {
  const { deps, calls, toast } = harness();
  expect(sendInBackground(deps)).toBe(true);
  expect(calls).toEqual(["submit", "new:project-1"]);
  expect(toast()?.title).toBe("Started in background");
  toast()!.actions![0]!.run();
  expect(calls[2]).toBe("open:thread:a");
});

test("a server thread gets a new thread without the toast", () => {
  const { deps, calls, toast } = harness({ isDraft: () => false });
  expect(sendInBackground(deps)).toBe(true);
  expect(calls).toEqual(["submit", "new:project-1"]);
  expect(toast()).toBeNull();
});

test("nothing happens while the prompt cannot send, or when the send did not start", () => {
  const blocked = harness({ canSend: () => false });
  expect(sendInBackground(blocked.deps)).toBe(false);
  expect(blocked.calls).toEqual([]);
  const rejected = harness({ isSending: () => false });
  expect(sendInBackground(rejected.deps)).toBe(false);
  expect(rejected.calls).toEqual(["submit"]);
});

test("each command applies on its own route", () => {
  expect(sendBackgroundApplies("composer.sendBackground", true)).toBe(true);
  expect(sendBackgroundApplies("composer.sendBackground", false)).toBe(false);
  expect(sendBackgroundApplies("composer.sendAndNewThread", false)).toBe(true);
  expect(sendBackgroundApplies("composer.sendAndNewThread", true)).toBe(false);
});

test("a fresh composer that cannot open warns, and the prompt stays sent", () => {
  const { deps, calls, toast } = harness({ newThread: () => { throw new Error("No project"); } });
  expect(sendInBackground(deps)).toBe(true);
  expect(calls).toEqual(["submit"]);
  expect(toast()).toEqual({ type: "warning", title: "Could not open a fresh composer", description: "No project" });
});
