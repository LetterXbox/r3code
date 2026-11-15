import { expect, test } from "nsh/test";
import { isSteerRefusal, resolveSendIntent, sendWithSteerFallback, alternateComposerDispatchAction, deriveQueueState, parseRuns, resolveComposerDispatchMode, submitLabel, submitStatus, submitTooltip } from "./runState";

test("an idle thread starts a turn; a running one follows the setting and the modifier flips it", () => {
  expect(resolveComposerDispatchMode({ running: false, alternateModifier: true })).toBe("auto");
  expect(resolveComposerDispatchMode({ running: true, alternateModifier: false, activeTurnDefault: "steer" })).toBe("steer");
  expect(resolveComposerDispatchMode({ running: true, alternateModifier: true, activeTurnDefault: "steer" })).toBe("queue");
  expect(resolveComposerDispatchMode({ running: true, alternateModifier: true, activeTurnDefault: "queue" })).toBe("steer");
  expect(resolveComposerDispatchMode({ running: true, alternateModifier: false, activeTurnDefault: "steer", canSteer: false })).toBe("queue");
  expect(alternateComposerDispatchAction("queue")).toBe("steer");
});

const runs = parseRuns([
  { id: "r1", status: "interrupted", ordinal: 1, userMessageId: "m1", startedAt: "t" },
  { id: "r2", status: "queued", ordinal: 3, queuePosition: 2, queueHeld: true, userMessageId: "m3" },
  { id: "r3", status: "queued", ordinal: 2, queuePosition: 1, queueHeld: true, userMessageId: "m2" },
  { id: "bad" },
]);

test("queued runs sort by position, carry their message text, and report a held queue", () => {
  const state = deriveQueueState(runs, [{ id: "m2", body: "second" }, { id: "m3", body: "third" }]);
  expect(state.queued.map((item) => [item.runId, item.text])).toEqual([["r3", "second"], ["r2", "third"]]);
  expect(state.isHeld).toBe(true);
  expect(state.canSendNow).toBe(true);
  expect(state.resumableRunId).toBe("r1");
});

test("a queued guest message shows the guest's words rather than the attributed provider prompt", () => {
  const state = deriveQueueState(runs, [{ id: "m2", body: "Guest Alice said: hello", context: { guest: { text: "hello" } } }]);
  expect(state.queued[0]?.text).toBe("hello");
});

test("automatic completion and notification runs do not appear in the user queue", () => {
  const state = deriveQueueState(runs, [{ id: "m2", body: "user message" }], undefined, ["m3"]);
  expect(state.queued.map((item) => item.messageId)).toEqual(["m2"]);
  expect(state.isHeld).toBe(true);
});

test("a running turn blocks send-now and allows promoting a queued message into it", () => {
  const state = deriveQueueState(parseRuns([{ id: "a", status: "running", ordinal: 1, userMessageId: "m" }]), []);
  expect(state.activeRun?.id).toBe("a");
  expect(state.canSendNow).toBe(false);
  expect(state.canPromoteToSteer).toBe(true);
  expect(state.resumableRunId).toBe(null);
});

test("the primary action label and tooltip follow the web's resolution order", () => {
  expect(submitLabel({ showResume: true, editingQueued: false, running: true, mode: "steer" })).toBe("Resume thread");
  expect(submitLabel({ showResume: false, editingQueued: true, running: true, mode: "queue" })).toBe("Update queued message");
  expect(submitLabel({ showResume: false, editingQueued: false, running: true, mode: "queue" })).toBe("Queue message");
  expect(submitLabel({ showResume: false, editingQueued: false, running: true, mode: "steer" })).toBe("Steer message");
  expect(submitLabel({ showResume: false, editingQueued: false, running: false, mode: "auto" })).toBe("Submit message");
  expect(submitTooltip({ running: true, editingQueued: false, canSteer: true, followUp: "steer", label: "x", mac: true })).toBe("Click to steer, ⌘-click to queue");
});

test("compact before send renames the primary action and its tooltip, except while resuming or editing", () => {
  expect(submitLabel({ showResume: false, editingQueued: false, running: false, mode: "auto", compactsBeforeSend: true })).toBe("Compact and send");
  expect(submitLabel({ showResume: true, editingQueued: false, running: false, mode: "auto", compactsBeforeSend: true })).toBe("Resume thread");
  expect(submitLabel({ showResume: false, editingQueued: true, running: false, mode: "auto", compactsBeforeSend: true })).toBe("Update queued message");
  expect(submitTooltip({ running: false, editingQueued: false, canSteer: true, followUp: "steer", label: "x", mac: true, compactTokens: "212k" })).toBe("Summarize 212k tokens of history, then send");
});

test("promoting a queued message steers only when the provider takes steering", () => {
  const running = parseRuns([{ id: "a", status: "running", ordinal: 1, userMessageId: "m" }]);
  expect(deriveQueueState(running, [], { canPromoteToSteer: false, promoteSkipsCompaction: false }).canPromoteToSteer).toBe(false);
  expect(deriveQueueState(running, [], { canPromoteToSteer: true, promoteSkipsCompaction: false }).canPromoteToSteer).toBe(true);
  expect(deriveQueueState(running, [], { canPromoteToSteer: true, promoteSkipsCompaction: true }).promoteSkipsCompaction).toBe(true);
});

test("send intent by run state: starting and preparing are auto, running steers, non-steerable queues, idle is auto", () => {
  const base = { alternateModifier: false, activeTurnDefault: "steer" as const };
  expect(resolveSendIntent({ ...base, runStatus: null })).toBe("auto");
  expect(resolveSendIntent({ ...base, runStatus: "starting" })).toBe("auto");
  expect(resolveSendIntent({ ...base, runStatus: "preparing" })).toBe("auto");
  expect(resolveSendIntent({ ...base, runStatus: "queued" })).toBe("auto");
  expect(resolveSendIntent({ ...base, runStatus: "running" })).toBe("steer");
  expect(resolveSendIntent({ ...base, runStatus: "waiting" })).toBe("steer");
  expect(resolveSendIntent({ ...base, runStatus: "running", canSteer: false })).toBe("queue");
  expect(resolveSendIntent({ ...base, runStatus: "running", freshContext: true })).toBe("queue");
  expect(resolveSendIntent({ ...base, runStatus: "starting", alternateModifier: true })).toBe("auto");
  expect(resolveSendIntent({ runStatus: "running", alternateModifier: true, activeTurnDefault: "steer" })).toBe("queue");
});

test("a steer the server refuses is sent again as a queued message; other errors pass through", async () => {
  const sent: string[] = [];
  const rejection = (message: string) => Object.assign(new Error(message), { tag: "OrchestrationV2DispatchCommandError" });
  const refusing = async (mode: string) => { sent.push(mode); if (mode === "steer") throw rejection("No running provider turn found for active run run:thread:x:ordinal:6."); return "ok"; };
  expect(await sendWithSteerFallback(refusing, "steer")).toBe("ok");
  expect(sent).toEqual(["steer", "queue"]);
  expect(isSteerRefusal(rejection("anything at all"))).toBe(true);
  expect(isSteerRefusal(new Error("Target run r is stopping and cannot be steered."))).toBe(false);
  expect(isSteerRefusal(new Error("Environment disconnected"))).toBe(false);
  let failure = "";
  try { await sendWithSteerFallback(async () => { throw new Error("boom"); }, "steer"); } catch (error) { failure = String(error); }
  expect(failure).toContain("boom");
  const autoSent: string[] = [];
  await sendWithSteerFallback(async (mode) => { autoSent.push(mode); return 1; }, "auto");
  expect(autoSent).toEqual(["auto"]);
  const queuedRefusal: string[] = [];
  let second = "";
  try { await sendWithSteerFallback(async (mode) => { queuedRefusal.push(mode); throw rejection("nope"); }, "queue"); } catch (error) { second = String(error); }
  expect(queuedRefusal).toEqual(["queue"]);
  expect(second).toContain("nope");
});

test("the send button's status (ComposerPrimaryActions submitStatus) wins over the other tooltips", () => {
  expect(submitStatus({ environmentUnavailable: true, sending: true, editingQueued: false })).toBe("Environment disconnected");
  expect(submitStatus({ environmentUnavailable: false, preparingWorktree: true, sending: false, editingQueued: false })).toBe("Preparing worktree");
  expect(submitStatus({ environmentUnavailable: false, sending: true, editingQueued: false })).toBe("Submitting message");
  expect(submitStatus({ environmentUnavailable: false, sending: true, editingQueued: true })).toBe("Updating queued message");
  expect(submitStatus({ environmentUnavailable: false, sending: false, editingQueued: false })).toBe(null);
  expect(submitTooltip({ status: "Submitting message", running: false, editingQueued: false, canSteer: false, followUp: "steer", label: "Submit message", mac: true })).toBe("Submitting message");
});

test("voice preparing and the alternate-send shortcut reach the send tooltip", () => {
  expect(submitStatus({ environmentUnavailable: false, voicePreparing: true, preparingWorktree: true, sending: false, editingQueued: false })).toBe("Preparing voice input");
  expect(submitTooltip({ running: true, editingQueued: false, canSteer: true, followUp: "steer", label: "Steer message", mac: true, alternateShortcut: "⌘↵" })).toBe("Click to steer, ⌘-click or ⌘↵ to queue");
});
