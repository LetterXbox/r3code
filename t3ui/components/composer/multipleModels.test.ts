import { expect, test } from "nsh/test";
import { fanoutSelectionsFor, multipleModelLabel, multipleModelSendBlock, multipleModelTargetError, sendMultipleModels, toggleFanoutModel } from "./multipleModels";
import type { FanoutDeps } from "./multipleModels";

const a = { provider: "codex", model: "gpt-6" };
const b = { provider: "claudeAgent", model: "opus" };
const c = { provider: "claudeAgent", model: "sonnet" };

test("Shift+click adds a model; back to one model ends the multiple selection", () => {
  const added = toggleFanoutModel(null, a, b.provider, b.model);
  expect(added.selections).toEqual([a, b]);
  const removed = toggleFanoutModel(added.selections, a, a.provider, a.model);
  expect(removed).toEqual({ selections: null, single: b });
});

test("the trigger names two models then counts the rest", () => {
  const models = [{ provider: "codex", model: "gpt-6", label: "Codex: GPT-6" }, { provider: "claudeAgent", model: "opus", label: "Claude: Opus" }, { provider: "claudeAgent", model: "sonnet", label: "Claude: Sonnet" }];
  expect(multipleModelLabel([], models)).toBe("Choose models");
  expect(multipleModelLabel([a, b, c], models).endsWith(", 1 more")).toBe(true);
});

test("multipleModelSendBlock", () => {
  const ready = { selectionCount: 2, serverSupportsWorktreeBootstrap: true, isLocalDraftThread: true, isGitRepo: true, branch: "main" };
  expect(multipleModelSendBlock(ready)).toBe(null);
  expect(multipleModelSendBlock({ ...ready, serverSupportsWorktreeBootstrap: false })).toBe("server-outdated");
  expect(multipleModelSendBlock({ ...ready, branch: null })).toBe("needs-new-git-thread");
  expect(multipleModelSendBlock({ ...ready, isLocalDraftThread: false })).toBe("needs-new-git-thread");
});

test("one thread per model; failed models stay selected, the prompt comes back, and a retry of an uncertain one is refused", async () => {
  const toasts: string[] = [];
  const launched: string[] = [];
  let ids = 0;
  const deps = (fail: string | null): FanoutDeps => ({
    launch: async (threadId, item) => { launched.push(`${threadId}:${item.model}`); if (item.model === fail) throw new Error("boom"); },
    newThreadId: () => `t${++ids}`, toast: (input) => toasts.push(input.title), openThread: () => {}, confirm: async () => true,
  });
  let draft = "hi";
  const started = await sendMultipleModels({ draftId: "d1", selections: [a, b], text: "hi", models: [], clearDraft: () => { draft = ""; }, restoreDraft: () => { draft = "hi"; }, releaseAttachments: () => {}, deps: deps("opus") });
  expect(started).toBe(1);
  expect(toasts).toEqual(["Could not start opus", "Started 1 thread in background"]);
  expect(fanoutSelectionsFor("d1")).toEqual([b]);
  expect(draft).toBe("hi");
  toasts.length = 0;
  await sendMultipleModels({ draftId: "d1", selections: [b], text: "hi", models: [], clearDraft: () => {}, restoreDraft: () => {}, releaseAttachments: () => {}, deps: deps(null) });
  expect(toasts).toEqual(["Could not start opus"]);
});

test("multipleModelTargetError: unavailable provider and Antigravity block stop the send", () => {
  const ready = { instanceId: "codex", driver: "codex", name: "Codex", enabled: true, installed: true, available: true, status: "ready", authStatus: "authenticated", authLabel: null, version: null, unavailableReason: null, message: null, checkedAt: null, canInstall: false, canAuthenticate: false, models: [{ id: "gpt", name: "GPT" }] };
  const ag = { ...ready, instanceId: "ag", driver: "antigravity", models: [{ id: "g3", name: "G3" }] };
  expect(multipleModelTargetError([{ provider: "codex", model: "gpt" }, { provider: "ag", model: "g3" }], [ready, ag])).toBeNull();
  expect(multipleModelTargetError([{ provider: "missing", model: "m" }], [ready])).toBe("Provider for m is unavailable.");
  expect(multipleModelTargetError([{ provider: "ag", model: "old" }], [ag])).toBe("That Antigravity model is no longer available. Choose another model.");
});
