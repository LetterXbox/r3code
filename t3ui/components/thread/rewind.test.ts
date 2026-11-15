import { expect, test } from "nsh/test";
import { findRewindTarget, rewindableMessageIds, mergeRestoredPrompt, rewindBlockedReason, rewindToMessageWith } from "./rewind";
import { record } from "../../backend/client";
import type { Thread } from "../../store";

const thread: Thread = { id: "t1", projectId: "p", title: "T", status: "idle", pinned: false, updatedAt: 0 };

function projection(overrides: Record<string, unknown> = {}) {
  return {
    thread: { id: "t1", activeProviderThreadId: "pt", modelSelection: { instanceId: "codex" } },
    providerThreads: [{ id: "pt", providerSessionId: "s", providerInstanceId: "codex" }],
    attempts: [{ id: "a1", providerTurnId: "turn1" }, { id: "a2", providerTurnId: "turn2" }],
    providerTurns: [{ id: "turn1", runAttemptId: "a1", ordinal: 1, providerThreadId: "pt" }, { id: "turn2", runAttemptId: "a2", ordinal: 1, providerThreadId: "pt" }],
    runs: [
      { id: "r1", ordinal: 1, userMessageId: "m1", status: "completed", activeAttemptId: "a1" },
      { id: "r2", ordinal: 2, userMessageId: "m2", status: "completed", activeAttemptId: "a2" },
    ],
    checkpoints: [
      { id: "c0", scopeId: "s0", runId: null, ordinalWithinScope: 0, appRunOrdinal: null, status: "ready" },
      { id: "c1", scopeId: "s0", runId: "r1", ordinalWithinScope: 1, appRunOrdinal: 1, status: "ready" },
      { id: "c2", scopeId: "s0", runId: "r2", ordinalWithinScope: 2, appRunOrdinal: 2, status: "ready" },
    ],
    ...overrides,
  };
}

test("rewinds to the previous run's checkpoint, or the thread start for the first message", () => {
  const second = findRewindTarget(projection(), "m2");
  expect(second?.turnCount).toBe(1);
  expect(second?.checkpoint?.id).toBe("c1");
  expect(second?.witnessRunId).toBe("r2");
  const first = findRewindTarget(projection(), "m1");
  expect(first?.turnCount).toBe(0);
  expect(first?.checkpoint?.id).toBe("c0");
  expect(first?.witnessRunId).toBe("r2");
});

test("offers no rewind without a ready checkpoint, a known run or a provider turn", () => {
  expect(findRewindTarget(projection(), "unknown")).toBe(undefined);
  expect(findRewindTarget(projection({ checkpoints: [] }), "m1")).toBe(undefined);
  expect(findRewindTarget(projection({ providerTurns: [] }), "m2")).toBe(undefined);
  expect(findRewindTarget(projection({ runs: [{ id: "r1", ordinal: 1, userMessageId: "m1", status: "running", activeAttemptId: "a1" }] }), "m1")).toBe(undefined);
});

test("the restored prompt follows what is already in the composer", () => {
  expect(mergeRestoredPrompt("", "hello")).toBe("hello");
  expect(mergeRestoredPrompt("draft", "hello")).toBe("draft\n\nhello");
  expect(mergeRestoredPrompt("draft", "")).toBe("draft");
});

test("a running or disconnected thread cannot be rewound", () => {
  expect(rewindBlockedReason(thread, true, false)).toBe(null);
  expect(rewindBlockedReason({ ...thread, status: "running" }, true, false)).toBe("Interrupt the current turn before reverting checkpoints.");
  expect(rewindBlockedReason(thread, false, false)).toContain("Connect the environment");
});

function deps(projections: unknown[], calls: { method: string; payload: unknown }[], overrides: Record<string, unknown> = {}) {
  let reads = 0;
  return {
    request: async (method: string, payload: unknown) => {
      calls.push({ method, payload });
      if (method === "orchestration.getThreadProjection") return projections[Math.min(reads++, projections.length - 1)];
      return {};
    },
    connected: () => true, environment: () => "server", generation: () => 1, currentThread: () => thread,
    readAttachment: async () => new Blob(["abc"]), newId: () => "id", sleep: async () => {},
    ...overrides,
  };
}

const input = { message: { id: "m2", role: "user" as const, body: "  Fix it  " }, restoreFiles: false, composerBusy: false, composerAttachmentCount: 0, maxAttachments: 100 };

test("dispatches checkpoint.rollback and resolves with the prompt once the run is rolled back", async () => {
  const calls: { method: string; payload: unknown }[] = [];
  const rolledBack = projection({ runs: [
    { id: "r1", ordinal: 1, userMessageId: "m1", status: "completed", activeAttemptId: "a1" },
    { id: "r2", ordinal: 2, userMessageId: "m2", status: "rolled_back", activeAttemptId: "a2" },
  ] });
  const result = await rewindToMessageWith(deps([projection(), projection(), rolledBack], calls), { ...input, restoreFiles: true });
  expect(result.prompt).toBe("Fix it");
  const command = record(calls.find((call) => call.method === "orchestration.dispatchCommand")?.payload);
  expect(command?.type).toBe("checkpoint.rollback");
  expect(command?.restoreFiles).toBe(true);
  expect(command?.checkpointId).toBe("c1");
  expect(command?.scopeId).toBe("s0");
  expect(command?.threadId).toBe("t1");
});

test("a server rollback failure is reported and nothing is restored", async () => {
  const calls: { method: string; payload: unknown }[] = [];
  const failed = projection({ thread: { id: "t1", activeProviderThreadId: "pt", modelSelection: { instanceId: "codex" }, rollbackFailure: { requestId: "command:id", message: "Disk is read-only" } } });
  let message = "";
  try { await rewindToMessageWith(deps([projection(), failed], calls), input); } catch (cause) { message = cause instanceof Error ? cause.message : String(cause); }
  expect(message).toBe("Disk is read-only");
});

test("attachments that cannot be read stop the rewind before anything is dispatched", async () => {
  const calls: { method: string; payload: unknown }[] = [];
  let message = "";
  try {
    await rewindToMessageWith(deps([projection()], calls, { readAttachment: async () => { throw new Error("Attachment preview failed."); } }), {
      ...input, message: { ...input.message, attachments: [{ id: "a", name: "x.png", mimeType: "image/png", sizeBytes: 3, type: "image" }] },
    });
  } catch (cause) { message = cause instanceof Error ? cause.message : String(cause); }
  expect(message).toBe("Attachment preview failed.");
  expect(calls.some((call) => call.method === "orchestration.dispatchCommand")).toBe(false);
});

test("refuses while the composer is still preparing attachments", async () => {
  let message = "";
  try { await rewindToMessageWith(deps([projection()], []), { ...input, composerBusy: true }); } catch (cause) { message = cause instanceof Error ? cause.message : String(cause); }
  expect(message).toBe("Wait for attachments to finish preparing before rewinding.");
});

test("lists the messages that can be rewound to", () => {
  expect([...rewindableMessageIds(projection())].sort()).toEqual(["m1", "m2"]);
  expect([...rewindableMessageIds(projection({ checkpoints: [] }))]).toEqual([]);
});

test("an unavailable environment with a label reads Reconnect <label> before reverting checkpoints", () => {
  const thread = { id: "t", status: "idle" } as never;
  expect(rewindBlockedReason(thread, false, false, true, "Studio Mac")).toBe("Reconnect Studio Mac before reverting checkpoints.");
});
