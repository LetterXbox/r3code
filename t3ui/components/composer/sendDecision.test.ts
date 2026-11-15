import { expect, test } from "nsh/test";
import { deriveQueueState, parseRuns, resolveSendIntent } from "./runState";
import { deriveSteerState, observeThreadItem, providerState, providerTurnEnded, readActiveRun, resetThreadProviderState } from "./threadProviderState";

// Contract-shaped thread projection (OrchestrationV2ThreadProjection) pieces the composer reads.
const session = (steers: boolean) => ({ id: "s1", status: "running", capabilities: { turns: { supportsActiveSteering: steers, supportsSteeringByInterruptRestart: false, supportsQueuedMessages: true } } });
const run = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "run:thread:t1:ordinal:6", status, ordinal: 6, queuePosition: null, queueHeld: false, userMessageId: "message:1", freshContext: false,
  startedAt: "2026-01-01T00:00:00Z", activeAttemptId: "att1", providerThreadId: "pt1", ...extra,
});
const turn = (status: string) => ({ id: "turn1", providerThreadId: "pt1", runAttemptId: "att1", status, tokenUsage: null });

function decide(input: { run: Record<string, unknown> | null; turns: unknown[]; steers?: boolean; body?: string; followUp?: "steer" | "queue" }) {
  resetThreadProviderState();
  observeThreadItem({ kind: "snapshot", projection: {
    thread: { activeProviderThreadId: "pt1" }, providerSessions: [session(input.steers ?? true)],
    providerThreads: [{ id: "pt1", appThreadId: "t1", providerSessionId: "s1", updatedAt: "2026-01-01T00:00:00Z" }], providerTurns: input.turns,
  } });
  const records = input.run ? [input.run] : [];
  const messages = [{ id: "message:1", body: input.body ?? "hello" }];
  const first = deriveQueueState(parseRuns(records), messages).activeRun;
  const ended = first !== null && providerTurnEnded(providerState(), readActiveRun(records, first.id));
  const runs = parseRuns(records).filter((item) => item.id !== (ended ? first?.id : null));
  const active = deriveQueueState(runs, messages).activeRun;
  const steer = deriveSteerState({ data: providerState(), activeRun: readActiveRun(records, active?.id ?? null), appThreadId: "t1", activeMessage: messages.find((m) => m.id === active?.userMessageId) });
  const canSteer = !steer.promoteSkipsCompaction && steer.canPromoteToSteer;
  return resolveSendIntent({ runStatus: active?.status ?? null, alternateModifier: false, activeTurnDefault: input.followUp ?? "steer", canSteer });
}

test("an idle thread, or a run still preparing or starting, sends automatically", () => {
  expect(decide({ run: null, turns: [] })).toBe("auto");
  expect(decide({ run: run("preparing"), turns: [] })).toBe("auto");
  expect(decide({ run: run("starting"), turns: [] })).toBe("auto");
});

test("a steer needs a running run with a running provider turn on a steering provider", () => {
  expect(decide({ run: run("running"), turns: [turn("running")] })).toBe("steer");
  expect(decide({ run: run("running"), turns: [turn("running")], followUp: "queue" })).toBe("queue");
  expect(decide({ run: run("running"), turns: [turn("running")], steers: false })).toBe("queue");
});

test("a running run whose provider turn has not started queues instead of steering", () => {
  expect(decide({ run: run("running"), turns: [] })).toBe("queue");
  expect(decide({ run: run("running"), turns: [turn("starting")] })).toBe("queue");
});

test("a run whose provider turn already ended is not active: the send goes out automatically, never as a steer", () => {
  expect(decide({ run: run("running"), turns: [turn("completed")] })).toBe("auto");
});

test("a waiting run, and a running /compact, queue", () => {
  expect(decide({ run: run("waiting"), turns: [turn("running")] })).toBe("queue");
  expect(decide({ run: run("running"), turns: [turn("running")], body: "/compact" })).toBe("queue");
});
