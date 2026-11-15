import { expect, test } from "nsh/test";
import type { Thread } from "../../store";
import { threadMetaFromShell } from "../sidebar/threadMeta";
import { createThreadNotificationCoordinator } from "./threadNotificationCoordinator";
import {
  backgroundSnapshotOf,
  createThreadNotificationGate,
  nextBackgroundThreadAnnouncement,
  notificationToastView,
  notificationsEnabled,
  observeThread,
  readNotificationMode,
  runOutcomeText,
  shouldNotifyDesktop,
  shouldToast,
  type BackgroundThreadSnapshot,
  type ThreadNotificationKind,
} from "./threadNotifications.logic";

// A thread of the orchestration shell snapshot, as the server sends it.
const shell = (overrides: Record<string, unknown> = {}) => ({
  id: "thread-1", projectId: "project-1", title: "Fix the build", status: "completed", latestRunId: "run-1", activeRunId: null, activityRunStatus: null,
  latestRunStartedAt: "2026-11-11T10:00:00.000Z", latestRunCompletedAt: "2026-11-11T10:05:00.000Z", pendingRuntimeRequest: null, pendingGuestMessageCount: 0,
  blockedOnThreadWait: false, lastErrorClass: null, snoozedUntil: null, lastVisitedAt: "2026-11-11T10:06:00.000Z", ...overrides,
});
const thread = (overrides: Record<string, unknown> = {}): Thread => {
  const value = shell(overrides);
  return { id: String(value.id), projectId: "project-1", title: String(value.title), status: "idle", pinned: false, updatedAt: 0, meta: threadMetaFromShell(value) };
};

test("a finished run is settled with its completion time; a running one is not", () => {
  const done = observeThread(thread());
  expect(done.settled).toBe(true);
  expect(done.completedAt).toBe(Date.parse("2026-11-11T10:05:00.000Z"));
  expect(done.attention).toBe(null);
  const running = observeThread(thread({ status: "running", activeRunId: "run-1", activityRunStatus: "running", latestRunCompletedAt: null }));
  expect(running.settled).toBe(false);
  expect(running.completedAt).toBe(null);
});

test("approvals, questions, guest requests and failures need attention, keyed by run and status", () => {
  expect(observeThread(thread({ status: "running", pendingRuntimeRequest: { kind: "command_approval" } }))).toMatchObject({ status: "approval", attention: "run-1:approval" });
  expect(observeThread(thread({ status: "running", pendingRuntimeRequest: { kind: "user_input" } }))).toMatchObject({ status: "input", attention: "run-1:input" });
  expect(observeThread(thread({ pendingGuestMessageCount: 2 }))).toMatchObject({ status: "request" });
  expect(observeThread(thread({ status: "failed" }))).toMatchObject({ status: "failed", attention: "run-1:failed" });
  expect(observeThread(thread({ status: "failed", lastErrorClass: "usage_limit" }))).toMatchObject({ status: "limited" });
});

function gateWith() {
  const log: Array<[string, ThreadNotificationKind]> = [];
  return { log, gate: createThreadNotificationGate<string>((key, kind) => log.push([key, kind])) };
}
const obs = (overrides: Partial<{ attention: string | null; settled: boolean; completedAt: number | null }> = {}) => ({ attention: null, settled: false, completedAt: null, ...overrides });

test("the first sighting is a silent baseline, even for a thread that already finished", () => {
  const { gate, log } = gateWith();
  gate.observe("a", undefined, obs({ settled: true, completedAt: 100 }), { archived: false, quiet: false });
  gate.observe("a", obs({ settled: true, completedAt: 100 }), obs({ settled: true, completedAt: 100 }), { archived: false, quiet: false });
  expect(log).toEqual([]);
});

test("a new completion notifies once; a new attention key notifies as input", () => {
  const { gate, log } = gateWith();
  const prior = obs({ settled: true, completedAt: 100 });
  gate.observe("a", undefined, prior, { archived: false, quiet: false });
  gate.observe("a", prior, obs({ settled: true, completedAt: 200 }), { archived: false, quiet: false });
  gate.observe("a", obs({ settled: true, completedAt: 200 }), obs({ settled: true, completedAt: 200 }), { archived: false, quiet: false });
  gate.observe("a", obs({ settled: true, completedAt: 200 }), obs({ attention: "run-2:approval" }), { archived: false, quiet: false });
  gate.observe("a", obs({ attention: "run-2:approval" }), obs({ attention: "run-2:approval" }), { archived: false, quiet: false });
  expect(log).toEqual([["a", "completion"], ["a", "input"]]);
});

test("archived threads and quiet runs never notify completion", () => {
  const { gate, log } = gateWith();
  gate.observe("a", obs(), obs({ settled: true, completedAt: 100 }), { archived: true, quiet: false });
  gate.observe("b", obs(), obs({ settled: true, completedAt: 100 }), { archived: false, quiet: true });
  gate.observe("b", obs({ settled: true, completedAt: 100 }), obs({ settled: true, completedAt: 100 }), { archived: false, quiet: false });
  expect(log).toEqual([]);
});

test("toast titles, types and marks follow the thread's status", () => {
  expect(notificationToastView("completion", "ready")).toEqual({ title: "Thread completed", type: "success", leadingIcon: { name: "circle-check", tone: "success" } });
  expect(notificationToastView("input", "approval")).toEqual({ title: "Approval needed", type: "warning", leadingIcon: { name: "shield-question", tone: "warning" } });
  expect(notificationToastView("input", "limited")).toMatchObject({ title: "Usage limit reached", type: "warning" });
  expect(notificationToastView("input", "failed")).toEqual({ title: "Thread failed", type: "error", leadingIcon: { name: "circle-alert", tone: "destructive" } });
  expect(notificationToastView("input", "request").title).toBe("Guest request");
  expect(notificationToastView("input", "input")).toEqual({ title: "Input needed", type: "warning", leadingIcon: { name: "message-circle-question", tone: "info" } });
});

test("the saved notification settings decide whether anything is watched or shown", () => {
  expect(readNotificationMode("sound")).toBe("sound");
  expect(readNotificationMode("bogus")).toBe("off");
  expect(notificationsEnabled("off", false)).toBe(false);
  expect(notificationsEnabled("off", true)).toBe(true);
  expect(notificationsEnabled("notifications", false)).toBe(true);
  expect(shouldToast({ inApp: true, openThreadId: "b", threadId: "a" })).toBe(true);
  expect(shouldToast({ inApp: true, openThreadId: "a", threadId: "a" })).toBe(false);
  expect(shouldToast({ inApp: false, openThreadId: null, threadId: "a" })).toBe(false);
});

function coordinator(inApp: boolean, open: string | null = null) {
  const shown: Array<Record<string, any>> = [];
  const opened: string[] = [];
  const closed: string[] = [];
  const instance = createThreadNotificationCoordinator({
    show: (input) => { shown.push(input as Record<string, any>); return String(input.id); },
    close: (id) => closed.push(id),
    open: (id) => opened.push(id),
    isOpenThread: (id) => id === open,
    inApp: () => inApp,
  });
  return { instance, shown, opened, closed };
}

test("a thread finishing in the background raises Thread completed with an Open thread action", () => {
  const { instance, shown, opened, closed } = coordinator(true, "thread-2");
  const running = thread({ status: "running", activeRunId: "run-1", activityRunStatus: "running", latestRunCompletedAt: null });
  instance.observe([running]);
  expect(shown.length).toBe(0);
  instance.observe([thread()]);
  expect(shown.length).toBe(1);
  expect(shown[0]).toMatchObject({ title: "Thread completed", description: "Fix the build", type: "success", hideCopyButton: true });
  shown[0]!.actions[0].run();
  expect(opened).toEqual(["thread-1"]);
  expect(closed.length).toBe(1);
});

test("the open thread and a switched-off toggle raise nothing; a failure and an approval do", () => {
  const open = coordinator(true, "thread-1");
  open.instance.observe([thread({ status: "running", latestRunCompletedAt: null, activityRunStatus: "running", activeRunId: "run-1" })]);
  open.instance.observe([thread()]);
  expect(open.shown.length).toBe(0);
  const off = coordinator(false);
  off.instance.observe([thread({ status: "running", latestRunCompletedAt: null, activityRunStatus: "running", activeRunId: "run-1" })]);
  off.instance.observe([thread()]);
  expect(off.shown.length).toBe(0);
  const live = coordinator(true);
  live.instance.observe([thread()]);
  live.instance.observe([thread({ status: "running", pendingRuntimeRequest: { kind: "command_approval" } })]);
  live.instance.observe([thread({ status: "failed", latestRunId: "run-2" })]);
  expect(live.shown.map((toast) => toast.title)).toEqual(["Approval needed", "Thread failed"]);
});

test("subagent threads raise nothing of their own", () => {
  const { instance, shown } = coordinator(true);
  const child = { ...thread(), relations: { parentThreadId: "thread-0", linkOrigin: null, guestShare: null } } as Thread;
  instance.observe([child]);
  instance.observe([{ ...child, meta: threadMetaFromShell(shell({ status: "failed" })) } as Thread]);
  expect(shown.length).toBe(0);
});

const snapshot = (overrides: Partial<BackgroundThreadSnapshot> = {}): BackgroundThreadSnapshot => ({
  key: "a", title: "Fix the build", request: null, requestId: null, runId: "run-1", runStatus: "running", activeRunId: "run-1", snoozed: false, ...overrides,
});

test("the announcer is silent on first sight, then speaks a request or an ending once", () => {
  const first = nextBackgroundThreadAnnouncement(new Map(), [snapshot()], null);
  expect(first.announcement).toBe(null);
  const asked = nextBackgroundThreadAnnouncement(first.memory, [snapshot({ request: "approval" })], null);
  expect(asked.announcement).toBe("Needs approval: Fix the build");
  const same = nextBackgroundThreadAnnouncement(asked.memory, [snapshot({ request: "approval" })], null);
  expect(same.announcement).toBe(null);
  const done = nextBackgroundThreadAnnouncement(same.memory, [snapshot({ runStatus: "completed", activeRunId: null })], null);
  expect(done.announcement).toBe("Done: Fix the build");
  expect(nextBackgroundThreadAnnouncement(done.memory, [snapshot({ runStatus: "completed", activeRunId: null })], null).announcement).toBe(null);
});

test("the announcer skips the open thread, snoozed threads and an ending while another run works", () => {
  const base = nextBackgroundThreadAnnouncement(new Map(), [snapshot()], null).memory;
  expect(nextBackgroundThreadAnnouncement(base, [snapshot({ runStatus: "failed" })], "a").announcement).toBe(null);
  expect(nextBackgroundThreadAnnouncement(base, [snapshot({ runStatus: "failed", snoozed: true })], null).announcement).toBe(null);
  expect(nextBackgroundThreadAnnouncement(base, [snapshot({ runStatus: "cancelled", activeRunId: "run-2" })], null).announcement).toBe(null);
  expect(runOutcomeText("interrupted")).toBe("Stopped");
  expect(runOutcomeText("running")).toBe(null);
});

test("a shell thread reads into an announcer snapshot", () => {
  const view = backgroundSnapshotOf(thread({ status: "running", pendingRuntimeRequest: { kind: "user_input" }, snoozedUntil: "2999-01-01T00:00:00.000Z" }), Date.now());
  expect(view).toMatchObject({ key: "thread-1", title: "Fix the build", request: "input", runId: "run-1", snoozed: true });
});

function system(mode: "off" | "notifications" | "sound" | "notifications-and-sound", focused: boolean, inApp = true) {
  const notified: Array<[string, string]> = [];
  const sounds: string[] = [];
  const shown: Array<Record<string, any>> = [];
  const instance = createThreadNotificationCoordinator({
    show: (input) => { shown.push(input as Record<string, any>); return String(input.id); },
    close: () => undefined, open: () => undefined, isOpenThread: () => false, inApp: () => inApp,
    focused: () => focused, mode: () => mode, notify: (title, body) => notified.push([title, body]), sound: (kind) => sounds.push(kind),
  });
  instance.observe([thread({ status: "running", activeRunId: "run-1", activityRunStatus: "running", latestRunCompletedAt: null })]);
  instance.observe([thread()]);
  return { notified, sounds, shown };
}

test("a window that is not in front gets a system notification instead of a toast, when the mode asks for it", () => {
  const away = system("notifications", false);
  expect(away.notified).toEqual([["Thread completed", "Fix the build"]]);
  expect(away.shown.length).toBe(0);
  expect(system("off", false).notified).toEqual([]);
  expect(system("sound", false).notified).toEqual([]);
});

test("a window in front gets the toast and no system notification", () => {
  const front = system("notifications", true);
  expect(front.shown.length).toBe(1);
  expect(front.notified).toEqual([]);
  expect(system("off", false, true).shown.length).toBe(0);
});

test("the sound plays in the sound modes, whichever way the thread is shown", () => {
  expect(system("sound", true).sounds).toEqual(["completion"]);
  expect(system("notifications-and-sound", false).sounds).toEqual(["completion"]);
  expect(system("notifications", false).sounds).toEqual([]);
  expect(shouldNotifyDesktop({ mode: "notifications-and-sound", focused: false })).toBe(true);
  expect(shouldNotifyDesktop({ mode: "notifications", focused: true })).toBe(false);
  expect(shouldToast({ inApp: true, openThreadId: null, threadId: "a", focused: false })).toBe(false);
});
