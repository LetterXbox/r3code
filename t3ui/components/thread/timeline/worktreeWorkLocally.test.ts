import { expect, test } from "nsh/test";
import { workLocally, workLocallyResendDraftId, workLocallyStep } from "./worktreeWorkLocally";

test("Work locally cancels the running setup and marks the draft for a local resend only when the cancel took", async () => {
  const calls: string[] = [];
  const send = (cancelled: boolean) => async (method: string, payload: unknown) => { calls.push(`${method}:${JSON.stringify(payload)}`); return { cancelled }; };
  workLocallyResendDraftId.set(null);
  expect(await workLocally({ draftId: "d1", setupRunning: true, threadId: "d1", send: send(false) })).toBe(false);
  expect(workLocallyResendDraftId()).toBe(null);
  expect(await workLocally({ draftId: "d1", setupRunning: false, threadId: "d1", send: send(true) })).toBe(false);
  expect(await workLocally({ draftId: null, setupRunning: true, threadId: "d1", send: send(true) })).toBe(false);
  expect(await workLocally({ draftId: "d1", setupRunning: true, threadId: "d1", send: send(true) })).toBe(true);
  expect(workLocallyResendDraftId()).toBe("d1");
  expect(calls).toEqual(['worktreeSetup.cancel:{"threadId":"d1"}', 'worktreeSetup.cancel:{"threadId":"d1"}']);
  workLocallyResendDraftId.set(null);
});

test("the resend waits for an idle draft, switches it to local first, then sends", () => {
  const base = { pendingDraftId: "d1", draftId: "d1", isDraft: true, sending: false, connected: true, workspaceType: "worktree" };
  expect(workLocallyStep({ ...base, sending: true })).toBe("wait");
  expect(workLocallyStep({ ...base, draftId: "other" })).toBe("wait");
  expect(workLocallyStep({ ...base, isDraft: false })).toBe("wait");
  expect(workLocallyStep({ ...base, pendingDraftId: null })).toBe("wait");
  expect(workLocallyStep(base)).toBe("switch");
  expect(workLocallyStep({ ...base, workspaceType: "root" })).toBe("send");
});
