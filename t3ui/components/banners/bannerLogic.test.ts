import { expect, test } from "nsh/test";
import { providerStatus, shellThread } from "./bannerFixtures";
import {
  backgroundWorkNowItem, branchMismatchItem, branchMismatchKey, childInputNowItem, childThreadInputsTitle, environmentUnavailableItem, extensionStatusItem,
  formatUpcomingTimestamp, goalNowItem, isBackgroundWorkStopPending, limitRecoveryActive, orderComposerBanners, presentPendingBackgroundWork, presentProviderGoal,
  providerStatusAlert, providerStatusBannerKey, providerStatusMessage, resolveLocalCheckoutBranchMismatch, runStopNowItem, shouldShowBranchMismatchBanner,
  shouldShowProviderStatusBanner, threadErrorAlert, threadErrorBannerMessage, threadNowSlots, usageLimitRecoveryItem, type RecoveryInput,
} from "./bannerLogic";
import { serverUpdateItem } from "./serverUpdate";
import { threadBannerFromShell } from "./threadBannerShell";

const noop = () => {};
const status = (overrides: Partial<typeof providerStatus> = {}) => ({ ...providerStatus, ...overrides });

// ---- Provider status ----

test("a ready, disabled or missing provider shows no provider banner", () => {
  expect(providerStatusBannerKey(null)).toBeNull();
  expect(providerStatusBannerKey(status({ status: "disabled" }))).toBeNull();
  expect(providerStatusBannerKey(status())).toBeNull();
});

test("Antigravity with unknown restart auth is not a failure", () => {
  expect(providerStatusBannerKey(status({ driver: "antigravity", status: "warning", authStatus: "unknown" }))).toBeNull();
  expect(providerStatusBannerKey(status({ driver: "antigravity", status: "warning", authStatus: "unauthenticated" }))).not.toBeNull();
});

test("a dismissed provider banner returns when the status changes", () => {
  const broken = status({ status: "error", authStatus: "unauthenticated" });
  const key = providerStatusBannerKey(broken);
  expect(shouldShowProviderStatusBanner(broken, null)).toBe(true);
  expect(shouldShowProviderStatusBanner(broken, key)).toBe(false);
  expect(shouldShowProviderStatusBanner({ ...broken, message: "Token expired" }, key)).toBe(true);
});

test("a ready provider on a broken version shows an error; an unsupported one a status warning", () => {
  expect(providerStatusBannerKey(status(), { status: "supported", message: null })).toBeNull();
  const broken = providerStatusAlert({ status: status(), advisory: { status: "broken", message: "Crashes on start." }, dismissedKey: null, refreshing: false, canRefresh: true, onRefresh: noop, onOpenSetup: noop, onDismiss: noop })!;
  expect(broken.title).toBe("Claude 2.3.1 is known to be broken");
  expect(broken.variant).toBe("error");
  expect(broken.role).toBe("alert");
  expect(broken.message).toBe("Crashes on start.");
  const unsupported = providerStatusAlert({ status: status(), advisory: { status: "unsupported", message: "Update to 2.4." }, dismissedKey: null, refreshing: false, canRefresh: true, onRefresh: noop, onOpenSetup: noop, onDismiss: noop })!;
  expect(unsupported.title).toBe("Claude 2.3.1 is unsupported");
  expect(unsupported.variant).toBe("warning");
  expect(unsupported.role).toBe("status");
});

test("an unauthenticated provider shows the web copy and offers setup only when it can", () => {
  const input = { status: status({ status: "error", authStatus: "unauthenticated" }), advisory: null, dismissedKey: null, refreshing: false, canRefresh: true, onRefresh: noop, onOpenSetup: noop, onDismiss: noop };
  const cli = providerStatusAlert(input)!;
  expect(cli.title).toBe("Claude is unauthenticated");
  expect(cli.message).toBe("Sign in via the CLI to authenticate again.");
  expect(cli.actions.map((action) => action.label)).toEqual(["Refresh"]);
  expect(cli.dismissLabel).toBe("Dismiss Claude provider error");
  const setup = providerStatusAlert({ ...input, status: status({ status: "error", authStatus: "unauthenticated", canAuthenticate: true }) })!;
  expect(setup.message).toBe("Open provider setup to sign in.");
  expect(setup.actions.map((action) => action.label)).toEqual(["Open provider setup", "Refresh"]);
});

test("Refresh shows its progress and disables without permission", () => {
  const base = { status: status({ status: "warning" }), advisory: null, dismissedKey: null, canRefresh: true, onRefresh: noop, onOpenSetup: noop, onDismiss: noop };
  expect(providerStatusAlert({ ...base, refreshing: true })!.actions[0]).toMatchObject({ label: "Refreshing...", disabled: true });
  expect(providerStatusAlert({ ...base, refreshing: false, canRefresh: false })!.actions[0]).toMatchObject({ label: "Refresh", disabled: true });
  expect(providerStatusAlert({ ...base, refreshing: false })!.variant).toBe("warning");
  expect(providerStatusMessage(status({ status: "warning" }))).toBe("Claude provider has limited availability.");
  expect(providerStatusMessage(status({ status: "error", installed: false, canInstall: true }))).toBe("Open provider setup to install claudeAgent on this environment.");
});

// ---- Thread error ----

const errorInput = { error: "boom", errorClass: null, errorCode: null, limitRecoveryShown: false, dismissed: false, onCopyAdminRequest: noop, onOpenChatGptUsage: noop, onDismiss: noop };

test("a thread error shows its nested JSON message and an expander for the raw text", () => {
  const raw = JSON.stringify({ error: { message: "Overloaded, retry later." } });
  expect(threadErrorBannerMessage(raw)).toBe("Overloaded, retry later.");
  expect(threadErrorBannerMessage("plain text")).toBe("plain text");
  const alert = threadErrorAlert({ ...errorInput, error: raw })!;
  expect(alert.message).toBe("Overloaded, retry later.");
  expect(alert.full).toBe(raw);
  expect(alert.variant).toBe("error");
  expect(threadErrorAlert(errorInput)!.full).toBeUndefined();
});

test("a thread error hides when dismissed, empty, or told by the usage-limit recovery card", () => {
  expect(threadErrorAlert({ ...errorInput, error: null })).toBeNull();
  expect(threadErrorAlert({ ...errorInput, dismissed: true })).toBeNull();
  expect(threadErrorAlert({ ...errorInput, limitRecoveryShown: true })).toBeNull();
});

test("a usage-limit class is a warning; the ChatGPT limits swap the copy and action", () => {
  expect(threadErrorAlert({ ...errorInput, errorClass: "usage_limit" })!.variant).toBe("warning");
  const personal = threadErrorAlert({ ...errorInput, errorCode: "subscription_sharing_usage_limit_exceeded" })!;
  expect(personal.title).toBe("ChatGPT usage limit reached");
  expect(personal.mark).toBe("openai");
  expect(personal.actions.map((action) => action.label)).toEqual(["Manage usage"]);
  const workspace = threadErrorAlert({ ...errorInput, errorCode: "subscription_sharing_workplace_individual_usage_limit_exceeded" })!;
  expect(workspace.message).toContain("workspace's limit");
  expect(workspace.actions.map((action) => action.label)).toEqual(["Copy request for admin"]);
});

test("the recovery card owns a failed usage-limit run's error", () => {
  const shell = threadBannerFromShell(shellThread({ status: "failed", lastErrorClass: "usage_limit", usageLimitResetAt: "2026-11-11T15:00:00.000Z" }));
  expect(limitRecoveryActive(shell)).toBe(true);
  expect(limitRecoveryActive(threadBannerFromShell(shellThread({ status: "failed", lastErrorClass: "provider_error" })))).toBe(false);
  expect(limitRecoveryActive(undefined)).toBe(false);
});

// ---- Thread-now lines ----

test("a goal row titles by status and usage, resumes only while idle, and always clears", () => {
  const goal = { objective: "Ship the port", status: "paused" as const, tokensUsed: 12_500, tokenBudget: 50_000, timeUsedSeconds: 125, checks: 3 };
  expect(presentProviderGoal(goal, false)).toMatchObject({ title: "Goal paused", usage: "13k / 50k tokens · 2m 5s · 3 checks", canResume: true });
  expect(presentProviderGoal({ objective: "x", status: "active" }, false).title).toBe("Goal set");
  expect(presentProviderGoal({ objective: "x", status: "active" }, true).title).toBe("Pursuing goal");
  expect(presentProviderGoal({ objective: "x", status: "complete" }, false).canResume).toBe(false);
  const sent: string[] = [];
  const idle = goalNowItem({ threadId: "t", goal, isWorking: false, onSendCommand: (text) => sent.push(text) });
  expect(idle.actions.map((action) => action.label)).toEqual(["Resume", "Clear"]);
  idle.actions[0]!.run();
  idle.actions[1]!.run();
  expect(sent).toEqual(["/goal resume", "/goal clear"]);
  expect(goalNowItem({ threadId: "t", goal, isWorking: true, onSendCommand: noop }).actions.map((action) => action.label)).toEqual(["Clear"]);
});

test("background work names what runs and waits", () => {
  expect(presentPendingBackgroundWork([])).toBeNull();
  expect(presentPendingBackgroundWork([{ taskId: "a", kind: "command", description: "bash -lc 'pnpm dev'" }])!.title).toBe("Running · pnpm dev");
  expect(presentPendingBackgroundWork([{ taskId: "a", kind: "command" }])!.title).toBe("Running a command");
  expect(presentPendingBackgroundWork([{ taskId: "a", kind: "subagent" }])!.title).toBe("Waiting on a subagent");
  expect(presentPendingBackgroundWork([{ taskId: "a", kind: "command" }, { taskId: "b", kind: "command", awaited: true }, { taskId: "c", kind: "subagent" }])!.title).toBe("Waiting on 1 subagent and 2 commands");
});

test("the background-work row shows elapsed time, the single task's detail, Open for a subagent, and Stop", () => {
  const stopped: string[] = [];
  const item = backgroundWorkNowItem({
    threadId: "t", tasks: [{ taskId: "a", kind: "subagent", description: "Review the diff", childThreadId: "child-1" }],
    startedAt: () => "2026-11-11T10:00:00.000Z", activity: () => "Reading files", stopDisabled: false, stopping: false, onStop: () => stopped.push("stop"), onOpenThread: (id) => stopped.push(id),
  })!;
  expect(item.title).toBe("Waiting · Review the diff");
  expect(item.description).toBe("Reading files");
  expect(item.elapsedSince).toBe("2026-11-11T10:00:00.000Z");
  expect(item.actions.map((action) => action.label)).toEqual(["Open", "Stop"]);
  item.actions[0]!.run();
  item.actions[1]!.run();
  expect(stopped).toEqual(["child-1", "stop"]);
  expect(backgroundWorkNowItem({ threadId: "t", tasks: [{ taskId: "a", kind: "command" }], startedAt: () => null, activity: () => null, stopDisabled: true, stopping: true, onStop: noop, onOpenThread: noop })!.actions[0]).toMatchObject({ label: "Stopping...", disabled: true });
});

test("an accepted background Stop stays pending while its tasks are listed", () => {
  const request = { threadKey: "t", taskIds: ["a"], retryAt: Date.now() + 10_000 };
  expect(isBackgroundWorkStopPending(null, "t", [{ taskId: "a" }], false)).toBe(false);
  expect(isBackgroundWorkStopPending(request, "t", [{ taskId: "a" }], false)).toBe(true);
  expect(isBackgroundWorkStopPending(request, "t", [], false)).toBe(false);
  expect(isBackgroundWorkStopPending(request, "t", [{ taskId: "a" }], true)).toBe(false);
  expect(isBackgroundWorkStopPending({ ...request, retryAt: null }, "t", [], false)).toBe(true);
});

test("a pending Stop says Stopping; an unanswered one offers Force stop when the server can", () => {
  const stopping = runStopNowItem({ threadId: "t", stop: { state: "stopping", runId: "r", requestedAt: "2026-11-11T10:00:00.000Z", background: false }, canForceStop: true, forceStopping: false, onForceStop: noop });
  expect(stopping.title).toBe("Stopping");
  expect(stopping.actions).toEqual([]);
  const unresponsive = { state: "unresponsive" as const, runId: "r", requestedAt: "2026-11-11T10:00:00.000Z", background: false };
  const forced: string[] = [];
  const offered = runStopNowItem({ threadId: "t", stop: unresponsive, canForceStop: true, forceStopping: false, onForceStop: () => forced.push("force") });
  expect(offered).toMatchObject({ title: "Agent not responding to Stop", description: "It may be short on memory. Force stop kills its processes.", tone: "warning" });
  offered.actions[0]!.run();
  expect(forced).toEqual(["force"]);
  expect(runStopNowItem({ threadId: "t", stop: unresponsive, canForceStop: false, forceStopping: false, onForceStop: noop }).actions).toEqual([]);
  expect(runStopNowItem({ threadId: "t", stop: unresponsive, canForceStop: true, forceStopping: true, onForceStop: noop }).actions[0]).toMatchObject({ label: "Force stopping...", disabled: true });
});

test("a subagent's question rolls up as one line, unless the parent itself waits", () => {
  const children = [{ id: "c1", title: "Reviewer", sideChat: false, hasPendingApprovals: false }];
  expect(childThreadInputsTitle(children)).toBe("Subagent needs input");
  expect(childThreadInputsTitle([{ ...children[0]!, hasPendingApprovals: true }])).toBe("Subagent needs approval");
  expect(childThreadInputsTitle([{ ...children[0]!, sideChat: true }])).toBe("Side chat needs input");
  expect(childThreadInputsTitle([...children, { id: "c2", title: "B", sideChat: false, hasPendingApprovals: true }])).toBe("2 subagents need you");
  expect(childThreadInputsTitle([...children, { id: "c2", title: "B", sideChat: true, hasPendingApprovals: false }])).toBe("2 threads need input");
  const opened: string[] = [];
  const item = childInputNowItem({ children, parentAwaitingUser: false, onOpenThread: (id) => opened.push(id) })!;
  expect(item).toMatchObject({ icon: "message-circle", waitingLabel: "Subagent waiting" });
  expect(item.actions[0]!.label).toBe("Open question");
  item.actions[0]!.run();
  expect(opened).toEqual(["c1"]);
  expect(childInputNowItem({ children: [{ ...children[0]!, hasPendingApprovals: true }], parentAwaitingUser: false, onOpenThread: noop })!.actions[0]!.label).toBe("Open approval");
  expect(childInputNowItem({ children, parentAwaitingUser: true, onOpenThread: noop })).toBeNull();
  expect(childInputNowItem({ children: [], parentAwaitingUser: false, onOpenThread: noop })).toBeNull();
});

test("the slots follow the reference: an unresponsive Stop takes attention, a pending one the work row", () => {
  const base = {
    shell: threadBannerFromShell(shellThread({ goal: { objective: "Ship", status: "active" }, pendingBackgroundTasks: [{ taskId: "a", kind: "command", description: "sleep 9" }] })),
    sessionRuns: { runs: [{ id: "r", ordinal: 1, status: "running" }], interrupts: [{ runId: "r", type: "run_interrupt_request" as const, startedAt: "2026-11-11T10:00:00.000Z", updatedAt: null, unresponsiveAt: null }] },
    isWorking: true, children: [{ id: "c", title: "C", sideChat: false, hasPendingApprovals: false }], parentAwaitingUser: false, threadId: "t",
    canOperate: true, canForceStop: true, forceStopping: false, stoppingBackground: false, taskStartedAt: () => null, taskActivity: () => null,
    onSendCommand: noop, onForceStop: noop, onStopBackground: noop, onOpenThread: noop,
  };
  const stopping = threadNowSlots(base);
  expect(stopping.attention?.id).toBe("child-input:c");
  expect(stopping.work?.id).toBe("run-stop:t");
  expect(stopping.goal?.id).toBe("goal:t");
  const unresponsive = threadNowSlots({ ...base, sessionRuns: { ...base.sessionRuns, interrupts: [{ ...base.sessionRuns.interrupts[0]!, unresponsiveAt: "2026-11-11T10:00:20.000Z" }] } });
  expect(unresponsive.attention?.id).toBe("run-stop:t");
  expect(unresponsive.work).toBeNull();
  const idle = threadNowSlots({ ...base, isWorking: false, sessionRuns: { runs: [], interrupts: [] } });
  expect(idle.work?.id).toBe("background-work:t");
  expect(threadNowSlots({ ...base, isWorking: true, sessionRuns: { runs: [], interrupts: [] } }).work).toBeNull();
});

// ---- Composer banners ----

test("the branch mismatch needs a local checkout, a different current branch and, to show, draft content or an earlier reveal", () => {
  const local = { local: true, worktreePath: null, threadBranch: "feature", currentBranch: "main" };
  expect(resolveLocalCheckoutBranchMismatch(local)).toEqual({ threadBranch: "feature", currentBranch: "main" });
  expect(resolveLocalCheckoutBranchMismatch({ ...local, local: false })).toBeNull();
  expect(resolveLocalCheckoutBranchMismatch({ ...local, worktreePath: "/w" })).toBeNull();
  expect(resolveLocalCheckoutBranchMismatch({ ...local, currentBranch: "feature" })).toBeNull();
  expect(resolveLocalCheckoutBranchMismatch({ ...local, currentBranch: null })).toBeNull();
  expect(branchMismatchKey("t", { threadBranch: "a", currentBranch: "b" })).toBe("t:a:b");
  expect(branchMismatchKey(null, { threadBranch: "a", currentBranch: "b" })).toBeNull();
  const shown = { hasMismatch: true, isDismissed: false, composerHasContent: false, wasShownForCurrentMismatch: false };
  expect(shouldShowBranchMismatchBanner(shown)).toBe(false);
  expect(shouldShowBranchMismatchBanner({ ...shown, composerHasContent: true })).toBe(true);
  expect(shouldShowBranchMismatchBanner({ ...shown, wasShownForCurrentMismatch: true })).toBe(true);
  expect(shouldShowBranchMismatchBanner({ ...shown, composerHasContent: true, isDismissed: true })).toBe(false);
  expect(shouldShowBranchMismatchBanner({ ...shown, composerHasContent: true, hasMismatch: false })).toBe(false);
});

test("the branch mismatch notice says where it ran and restores the branch", () => {
  const calls: string[] = [];
  const item = branchMismatchItem({ key: "k", mismatch: { threadBranch: "feature", currentBranch: "main" }, restoreDisabled: false, restoring: false, onRestore: () => calls.push("restore"), onDismiss: () => calls.push("dismiss") });
  expect(item).toMatchObject({ id: "branch-mismatch:k", variant: "info", title: "Branch changed from feature", description: "This thread last ran on feature. Sending will continue on main." });
  item.actions[0]!.run();
  item.onDismiss!();
  expect(calls).toEqual(["restore", "dismiss"]);
  expect(branchMismatchItem({ key: "k", mismatch: { threadBranch: "f", currentBranch: "m" }, restoreDisabled: true, restoring: true, onRestore: noop, onDismiss: noop }).actions[0]).toMatchObject({ label: "Restoring...", disabled: true });
});

test("the Pi extension status joins the provider's lines and hides when empty", () => {
  expect(extensionStatusItem([])).toBeNull();
  expect(extensionStatusItem([{ key: "a", text: "Indexing" }, { key: "b", text: "2 tools" }])!.title).toBe("Pi · Indexing · 2 tools");
});

const recovery = (overrides: Partial<RecoveryInput> = {}): RecoveryInput => ({
  runId: "run-1", errorCode: null, resetAt: "2026-11-11T15:00:00.000Z", stoppedAt: "2026-11-11T10:00:00.000Z", settled: false, requestPending: false,
  snoozedUntil: null, recovery: null, now: Date.parse("2026-11-11T11:00:00.000Z"), formatUpcoming: (iso) => `at ${iso}`, pending: false, onToggle: noop, onCopyAdminRequest: noop, onOpenChatGptUsage: noop, ...overrides,
});

test("usage-limit recovery offers resume and snooze before the reset, and not once settled or asked a question", () => {
  const offered = usageLimitRecoveryItem(recovery());
  expect(offered).toMatchObject({ variant: "warning", group: "environment", title: "Usage limit reached", description: "Resets at 2026-11-11T15:00:00.000Z" });
  expect(offered.actions.map((action) => action.label)).toEqual(["Resume at reset", "Snooze until reset"]);
  expect(usageLimitRecoveryItem(recovery({ settled: true })).actions).toEqual([]);
  expect(usageLimitRecoveryItem(recovery({ requestPending: true })).actions).toEqual([]);
  expect(usageLimitRecoveryItem(recovery({ resetAt: null })).description).toBe("Reset time unavailable; retry manually");
  expect(usageLimitRecoveryItem(recovery({ resetAt: "2026-11-11T09:00:00.000Z" })).actions).toEqual([]);
});

test("scheduled recovery says Resumes, cancels, and a snooze offers Wake now", () => {
  const scheduled = usageLimitRecoveryItem(recovery({ recovery: { runId: "run-1", resetAt: "2026-11-11T15:00:00.000Z", autoResume: true } }));
  expect(scheduled.description).toBe("Resumes at 2026-11-11T15:00:00.000Z");
  expect(scheduled.actions[0]!.label).toBe("Cancel auto-resume");
  const snoozed = usageLimitRecoveryItem(recovery({ recovery: { runId: "run-1", resetAt: "2026-11-11T15:00:00.000Z", autoResume: false, snooze: true }, snoozedUntil: "2026-11-11T15:00:00.000Z" }));
  expect(snoozed.actions[1]!.label).toBe("Wake now");
  const toggled: string[] = [];
  usageLimitRecoveryItem(recovery({ onToggle: (action) => toggled.push(action) })).actions.forEach((action) => action.run());
  expect(toggled).toEqual(["resume", "snooze"]);
  expect(usageLimitRecoveryItem(recovery({ pending: true })).actions.map((action) => action.label)).toEqual(["Saving...", "Saving..."]);
});

test("the ChatGPT limits replace the title and add Manage usage or the admin request", () => {
  const personal = usageLimitRecoveryItem(recovery({ errorCode: "subscription_sharing_usage_limit_exceeded" }));
  expect(personal).toMatchObject({ title: "ChatGPT usage limit reached" });
  expect(personal.actions.map((action) => action.label)).toEqual(["Resume at reset", "Snooze until reset", "Manage usage"]);
  const workspace = usageLimitRecoveryItem(recovery({ errorCode: "subscription_sharing_workplace_individual_usage_limit_exceeded" }));
  expect(workspace.description).toBe("You've reached your workspace's limit for using your ChatGPT plan in other apps.");
  expect(workspace.actions.at(-1)!.label).toBe("Copy request for admin");
});

test("the environment notice waits out a short reconnect, then offers Reconnect when offline", () => {
  const base = { label: "Local", error: null, graceElapsed: false, updateRunning: false, onReconnect: noop };
  expect(environmentUnavailableItem({ ...base, status: "connected" })).toBeNull();
  expect(environmentUnavailableItem({ ...base, status: "connecting" })).toBeNull();
  const reconnecting = environmentUnavailableItem({ ...base, status: "connecting", graceElapsed: true })!;
  expect(reconnecting).toMatchObject({ title: "Local is reconnecting", variant: "warning", group: "environment", actions: [] });
  expect(environmentUnavailableItem({ ...base, status: "connecting", graceElapsed: true, updateRunning: true })).toBeNull();
  const offline = environmentUnavailableItem({ ...base, status: "disconnected" })!;
  expect(offline).toMatchObject({ title: "Local is offline", description: "Environment disconnected. Your draft is kept here." });
  expect(offline.actions.map((action) => action.label)).toEqual(["Reconnect"]);
  expect(environmentUnavailableItem({ ...base, status: "error", error: "Connection refused" })).toMatchObject({ variant: "error", description: "Connection refused" });
});

test("a server update shows while running or failed and never while idle or dismissed", () => {
  const base = { failureDismissed: false, automaticEnvironment: false, serverLabel: "server", canRetry: true, onRetry: noop, onDismiss: noop };
  expect(serverUpdateItem({ ...base, state: { status: "idle" } })).toBeNull();
  const running = serverUpdateItem({ ...base, state: { status: "running", stage: "downloading", fromVersion: "1.0.0", targetVersion: "1.1.0" } })!;
  expect(running).toMatchObject({ title: "Updating server", description: "Downloading…", variant: "default", group: "environment" });
  expect(running.onDismiss).toBeUndefined();
  const failed = { status: "failed" as const, stage: "installing" as const, fromVersion: "1.0.0", targetVersion: "1.1.0", message: "Disk full" };
  const item = serverUpdateItem({ ...base, state: failed })!;
  expect(item).toMatchObject({ title: "Could not update server", description: "Disk full", variant: "error", dismissLabel: "Dismiss update notice" });
  expect(item.actions.map((action) => action.label)).toEqual(["Retry"]);
  expect(serverUpdateItem({ ...base, state: failed, failureDismissed: true })).toBeNull();
  expect(serverUpdateItem({ ...base, state: failed, automaticEnvironment: true })).toBeNull();
});

test("the stack puts the machine's notices before what needs you, keeping order within a group", () => {
  const item = (id: string, group?: "environment" | "attention") => ({ id, variant: "default" as const, icon: "info" as const, title: id, actions: [], ...(group ? { group } : {}) });
  expect(orderComposerBanners([item("branch"), item("env", "environment"), item("pi"), item("update", "environment")]).map((entry) => entry.id)).toEqual(["env", "update", "branch", "pi"]);
});

test("upcoming times read as the reference's day-aware form", () => {
  const now = new Date(2026, 10, 11, 10, 0).getTime();
  const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 30).toISOString();
  expect(formatUpcomingTimestamp(at(11, 15), "24-hour", now)).toBe("15:30");
  expect(formatUpcomingTimestamp(at(12, 9), "24-hour", now)).toBe("tomorrow at 09:30");
  expect(formatUpcomingTimestamp(at(10, 9), "24-hour", now)).toBe("yesterday at 09:30");
  expect(formatUpcomingTimestamp("not a date", "24-hour", now)).toBe("");
});

test("a saved environment offline long enough offers Disconnect server beside Reconnect", () => {
  const item = environmentUnavailableItem({ status: "disconnected", label: "Box", error: null, graceElapsed: true, updateRunning: false, onReconnect: () => {}, onDisconnect: () => {} });
  expect(item?.title).toBe("Box is offline");
  expect(item?.actions.map((action) => [action.label, action.title ?? null])).toEqual([["Reconnect", null], ["Disconnect server", "Hide this server's threads. Switch it on again in Environments."]]);
  const reconnecting = environmentUnavailableItem({ status: "connecting", label: "Box", error: null, graceElapsed: true, updateRunning: false, onReconnect: () => {}, onDisconnect: () => {} });
  expect(reconnecting?.title).toBe("Box is reconnecting");
  expect(reconnecting?.actions.map((action) => action.label)).toEqual(["Disconnect server"]);
});
