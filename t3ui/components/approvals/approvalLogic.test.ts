import { expect, test } from "nsh/test";
import { approvalRedirectNotice, redirectPendingApprovals, type ApprovalRedirectDeps, type RedirectApproval } from "./approvalLogic";

function deps(overrides: Partial<ApprovalRedirectDeps> & { pending?: () => RedirectApproval[] } = {}) {
  const calls: string[] = [];
  const toasts: string[] = [];
  const errors: string[] = [];
  let cleared = false;
  const base: ApprovalRedirectDeps = {
    pending: () => [],
    responding: () => [],
    draftKey: () => "draft",
    respond: async (id, decision, feedback) => { calls.push(`${id}:${decision}${feedback ? `:${feedback}` : ""}`); return true; },
    clearDraft: () => { cleared = true; },
    setError: (message) => errors.push(message),
    toast: (title) => toasts.push(title),
    ...overrides,
  };
  return { base, calls, toasts, errors, cleared: () => cleared };
}

test("notice copy follows the reference", () => {
  expect(approvalRedirectNotice({ draftChanged: true, declined: true, approvalResponding: false, approvalArrived: false })).toBe("Approval declined. Your message changed, so it wasn't sent.");
  expect(approvalRedirectNotice({ draftChanged: true, declined: false, approvalResponding: false, approvalArrived: false })).toBe("Your message changed, so it wasn't sent.");
  expect(approvalRedirectNotice({ draftChanged: false, declined: false, approvalResponding: true, approvalArrived: false })).toBe("An approval is already being answered, so your message wasn't sent.");
  expect(approvalRedirectNotice({ draftChanged: false, declined: true, approvalResponding: false, approvalArrived: true })).toBe("Another approval arrived, so your message wasn't sent.");
  expect(approvalRedirectNotice({ draftChanged: false, declined: false, approvalResponding: false, approvalArrived: false })).toBe(null);
});

test("a send over pending approvals declines each live one, skips gone ones, then sends", async () => {
  const shown: RedirectApproval[] = [{ id: "a", responseCapability: "live" }, { id: "b", responseCapability: "not_resumable" }, { id: "c" }];
  const d = deps({ pending: () => shown });
  expect(await redirectPendingApprovals({ shown, message: "do this instead", hasAttachmentsOrContext: false }, d.base)).toBe(true);
  expect(d.calls).toEqual(["a:decline", "c:decline"]);
  expect(d.toasts).toEqual([]);
});

test("an approval that takes feedback is declined with the message and nothing else is sent", async () => {
  const shown: RedirectApproval[] = [{ id: "a", responseCapability: "live", supportsFeedback: true }];
  const d = deps({ pending: () => shown });
  expect(await redirectPendingApprovals({ shown, message: " use yarn ", hasAttachmentsOrContext: false }, d.base)).toBe(false);
  expect(d.calls).toEqual(["a:decline:use yarn"]);
  expect(d.cleared()).toBe(true);
  const e = deps({ pending: () => shown });
  expect(await redirectPendingApprovals({ shown, message: "x", hasAttachmentsOrContext: true }, e.base)).toBe(false);
  expect(e.errors).toEqual(["Send approval feedback without attachments or added context."]);
  expect(e.calls).toEqual([]);
});

test("a changed draft, an approval being answered or a new approval stops the send with a notice", async () => {
  const shown: RedirectApproval[] = [{ id: "a", responseCapability: "live" }];
  let draft = "one";
  const changed = deps({ pending: () => shown, draftKey: () => draft, respond: async () => { draft = "two"; return true; } });
  expect(await redirectPendingApprovals({ shown, message: "one", hasAttachmentsOrContext: false }, changed.base)).toBe(false);
  expect(changed.toasts).toEqual(["Approval declined. Your message changed, so it wasn't sent."]);
  const busy = deps({ pending: () => shown, responding: () => ["a"] });
  expect(await redirectPendingApprovals({ shown, message: "one", hasAttachmentsOrContext: false }, busy.base)).toBe(false);
  expect(busy.calls).toEqual([]);
  expect(busy.toasts).toEqual(["An approval is already being answered, so your message wasn't sent."]);
  let pending: RedirectApproval[] = shown;
  const arrived = deps({ pending: () => pending, respond: async () => { pending = [{ id: "z", responseCapability: "live" }]; return true; } });
  expect(await redirectPendingApprovals({ shown, message: "one", hasAttachmentsOrContext: false }, arrived.base)).toBe(false);
  expect(arrived.toasts).toEqual(["Another approval arrived, so your message wasn't sent."]);
});
