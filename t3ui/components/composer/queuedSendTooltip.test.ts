import { expect, test } from "nsh/test";
import { queueDeps, queuedSendNowTooltip } from "./queueState";
import type { QueueState } from "./runState";

const base: QueueState = { activeRun: null, queued: [], isHeld: false, canSendNow: true, canPromoteToSteer: false, promoteSkipsCompaction: false, resumableRunId: null };

test("Send now says what it does (QueuedRunsControl)", () => {
  const original = queueDeps.queue;
  try {
    queueDeps.queue = () => base;
    expect(queuedSendNowTooltip(0)).toBe("Start a turn with this message");
    queueDeps.queue = () => ({ ...base, canSendNow: false, canPromoteToSteer: true, promoteSkipsCompaction: true });
    expect(queuedSendNowTooltip(1)).toBe("Skip compaction and send this message");
    queueDeps.queue = () => ({ ...base, canSendNow: false, canPromoteToSteer: true });
    expect(queuedSendNowTooltip(0, "Cmd+Enter")).toBe("Send into the current turn (Cmd+Enter)");
    expect(queuedSendNowTooltip(1, "Cmd+Enter")).toBe("Send into the current turn");
  } finally { queueDeps.queue = original; }
});

test("an open question blocks queued edits (queuedRunEditBlockedReason)", async () => {
  const { queuedRunEditBlockedReason } = await import("./QueuedRunsControl");
  expect(queuedRunEditBlockedReason({ openQuestionCount: 1 })).toBe("Answer the question to edit queued messages");
  expect(queuedRunEditBlockedReason({ openQuestionCount: 0 })).toBe(null);
});

test("an edited run that left the queue keeps a changed edit only into an empty thread draft (resolveQueuedEditExit)", async () => {
  const { resolveQueuedEditExit } = await import("./queueState");
  expect(resolveQueuedEditExit({ editChanged: false, threadDraftEmpty: true })).toBe("clean");
  expect(resolveQueuedEditExit({ editChanged: true, threadDraftEmpty: true })).toBe("kept");
  expect(resolveQueuedEditExit({ editChanged: true, threadDraftEmpty: false })).toBe("discarded");
});
