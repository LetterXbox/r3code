import { expect, test } from "nsh/test";
import { applyProviderLock, buildPickerInstances, listFor, lockedInstanceTooltip, pickerProviderLock, shouldApplyThreadModelPick, startedThreadModelChangeBlock, threadSupportsProviderHandoff } from "./pickerModel";

const model = (slug: string, name: string) => ({ slug, name, isCustom: false, capabilities: null });
const records = [
  { instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude", enabled: true, availability: "available", status: "ready", continuation: { groupKey: "anthropic:me" }, models: [model("opus", "Claude Opus")] },
  { instanceId: "claude_work", driver: "claudeAgent", displayName: "Claude Work", enabled: true, availability: "available", status: "ready", continuation: { groupKey: "anthropic:work" }, models: [model("opus", "Claude Opus")] },
  { instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, availability: "available", status: "ready", models: [model("gpt-6", "GPT-6")] },
];
const thread = { id: "t1", activeProviderThreadId: null, modelSelection: { instanceId: "claudeAgent", model: "opus" } };
const session = (handoff: boolean) => ({ id: "s1", status: "running", capabilities: { sessions: { supportsProviderSwitchingViaHandoff: handoff } } });

test("a fresh thread or draft is not locked", () => {
  expect(pickerProviderLock({ projection: null, records })).toBe(null);
  expect(pickerProviderLock({ projection: { thread, runs: [], providerSessions: [], providerThreads: [] }, records })).toBe(null);
});

test("a started thread locks its driver and continuation group unless its session can hand off", () => {
  const started = { thread, runs: [{ id: "r1", status: "completed" }], providerSessions: [session(false)], providerThreads: [] };
  expect(pickerProviderLock({ projection: started, records })).toEqual({ driver: "claudeAgent", continuationGroupKey: "anthropic:me" });
  const handoff = { ...started, providerSessions: [session(true)] };
  expect(threadSupportsProviderHandoff(handoff)).toBe(true);
  expect(pickerProviderLock({ projection: handoff, records })).toBe(null);
});

test("a running thread with no session cannot hand off", () => {
  expect(threadSupportsProviderHandoff({ thread, runs: [{ id: "r1", status: "running" }], providerSessions: [], providerThreads: [] })).toBe(false);
});

test("the lock lists other providers last, with no models", () => {
  const instances = applyProviderLock(buildPickerInstances(records, null), { driver: "claudeAgent", continuationGroupKey: "anthropic:me" });
  expect(instances.map((instance) => [instance.instanceId, instance.lockedOut === true])).toEqual([["claudeAgent", false], ["claude_work", true], ["codex", true]]);
  expect(listFor(instances, "favorites", "opus", new Set(), false).rows.map((row) => row.instanceId)).toEqual(["claudeAgent"]);
  expect(lockedInstanceTooltip("Codex")).toBe("Codex is unavailable in this thread. Start a new thread to switch providers.");
});

test("a started session refuses another instance unless it can hand off; the own instance applies to the thread", () => {
  const started = { thread, runs: [{ id: "r1", status: "completed" }], providerSessions: [session(false)], providerThreads: [] };
  expect(startedThreadModelChangeBlock({ projection: started, nextInstanceId: "claude_work" })).toEqual({
    title: "Start a new chat to switch providers", description: "This thread does not support switching providers after it has started.",
  });
  expect(startedThreadModelChangeBlock({ projection: started, nextInstanceId: "claudeAgent" })).toBe(null);
  expect(startedThreadModelChangeBlock({ projection: { ...started, providerSessions: [session(true)] }, nextInstanceId: "codex" })).toBe(null);
  expect(startedThreadModelChangeBlock({ projection: null, nextInstanceId: "codex" })).toBe(null);
  expect(shouldApplyThreadModelPick({ projection: started, instanceId: "claudeAgent" })).toBe(true);
  expect(shouldApplyThreadModelPick({ projection: started, instanceId: "codex" })).toBe(false);
  expect(shouldApplyThreadModelPick({ projection: null, instanceId: "claudeAgent" })).toBe(false);
});
