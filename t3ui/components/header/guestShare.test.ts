import { expect, test } from "nsh/test";
import { canShareWithGuest, closeGuestShare, createGuestShare, guestPendingLabel, guestShareCreateNote, resolveGuestMessage } from "./guestShare";

type Call = { method: string; payload: Record<string, unknown> };
function recorder(result: unknown = {}) {
  const calls: Call[] = [];
  const request = async (method: string, payload: unknown) => { calls.push({ method, payload: payload as Record<string, unknown> }); return result; };
  return { calls, request };
}

test("Share with guest needs a connected environment, the beta setting and an allowed T3 Connect", () => {
  const settings = { guestSharingEnabled: true };
  expect(canShareWithGuest({ settings, managedPolicy: null, connected: true })).toBe(true);
  expect(canShareWithGuest({ settings: { guestSharingEnabled: false }, managedPolicy: null, connected: true })).toBe(false);
  expect(canShareWithGuest({ settings: null, managedPolicy: null, connected: true })).toBe(false);
  expect(canShareWithGuest({ settings, managedPolicy: null, connected: false })).toBe(false);
  expect(canShareWithGuest({ settings, managedPolicy: { capabilities: { connect: false } }, connected: true })).toBe(false);
  expect(canShareWithGuest({ settings, managedPolicy: { capabilities: { connect: true } }, connected: true })).toBe(true);
});

test("creating a link asks guestShare.create and returns the URL the server sent", async () => {
  const { calls, request } = recorder({ url: "https://guest.example/s/abc", share: { id: "g" } });
  expect(await createGuestShare("thread-1", request)).toBe("https://guest.example/s/abc");
  expect(calls).toEqual([{ method: "guestShare.create", payload: { threadId: "thread-1" } }]);
  await expect(createGuestShare("thread-1", recorder({}).request)).rejects.toThrow("Could not create a guest link.");
});

test("the dialog says a new link ends the current one only when a share exists", () => {
  expect(guestShareCreateNote(false)).toBe("The link works once and expires in 24 hours.");
  expect(guestShareCreateNote(true)).toBe("A new link ends the current one.");
  expect(guestPendingLabel(1)).toBe("1 guest message waiting");
  expect(guestPendingLabel(3)).toBe("3 guest messages waiting");
});

test("stopping a share and dismissing a message are thread commands", async () => {
  const { calls, request } = recorder();
  await closeGuestShare("thread-1", request);
  await resolveGuestMessage({ threadId: "thread-1", guestMessageId: "gm-1", decision: "dismiss" }, request);
  expect(calls.map((call) => [call.method, call.payload.type, call.payload.threadId, call.payload.guestMessageId])).toEqual([
    ["orchestration.dispatchCommand", "thread.guest-share.close", "thread-1", undefined],
    ["orchestration.dispatchCommand", "thread.guest-message.dismiss", "thread-1", "gm-1"],
  ]);
});

test("sending a guest message queues a turn with no client text, so the server supplies it", async () => {
  const { calls, request } = recorder();
  await resolveGuestMessage({ threadId: "thread-1", guestMessageId: "gm-1", decision: "send" }, request);
  const payload = calls[0]!.payload;
  expect(payload).toMatchObject({ type: "message.dispatch", threadId: "thread-1", guestMessageId: "gm-1", text: "", attachments: [], dispatchMode: { type: "queue_after_active" }, createdBy: "user", creationSource: "web" });
  expect(payload.messageId).toBe(payload.commandId);
});
