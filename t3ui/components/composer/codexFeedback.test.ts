import { expect, test } from "nsh/test";
import { codexFeedbackNotice, feedbackBannerItem, feedbackSubmissionsFor, feedbackUploadInFlight, parseCodexFeedbackCommand, runCodexFeedback } from "./codexFeedback";

test("parses /feedback with and without a reason", () => {
  expect(parseCodexFeedbackCommand("/feedback")).toEqual({});
  expect(parseCodexFeedbackCommand("  /FEEDBACK   it broke \n")).toEqual({ reason: "it broke" });
  expect(parseCodexFeedbackCommand("/feedbackx")).toBeNull();
  expect(parseCodexFeedbackCommand("hi /feedback")).toBeNull();
});

test("notice copy per status", () => {
  const base = { id: "m", command: "/feedback", createdAt: "t" };
  expect(codexFeedbackNotice({ ...base, status: "interrupted" })).toBeNull();
  expect(codexFeedbackNotice({ ...base, status: "uploading" })?.title).toBe("Sending feedback to OpenAI...");
  expect(codexFeedbackNotice({ ...base, status: "sent", feedbackId: "abc" })).toEqual({ title: "Feedback sent to OpenAI", description: "Thread ID: abc" });
  expect(codexFeedbackNotice({ ...base, status: "failed", errorMessage: "no" })).toEqual({ title: "Could not send feedback to OpenAI", description: "no" });
});

test("a successful upload clears the draft and ends sent", async () => {
  let cleared = 0;
  let seen: unknown;
  const done = runCodexFeedback({ threadId: "t1", command: "/feedback why", reason: "why", clearDraft: () => { cleared += 1; }, request: async (method, payload) => { seen = [method, payload]; expect(feedbackUploadInFlight("t1")).toBe(true); return { feedbackId: "fb-1" }; } });
  await done;
  expect(cleared).toBe(1);
  expect(seen).toEqual(["provider.uploadFeedback", { threadId: "t1", reason: "why" }]);
  expect(feedbackSubmissionsFor("t1")[0]).toMatchObject({ status: "sent", feedbackId: "fb-1" });
  expect(feedbackUploadInFlight("t1")).toBe(false);
});

test("a failed upload reports the message", async () => {
  await runCodexFeedback({ threadId: "t2", command: "/feedback", clearDraft: () => {}, request: async () => { throw new Error("Unavailable"); } });
  expect(feedbackSubmissionsFor("t2")[0]).toMatchObject({ status: "failed", errorMessage: "Unavailable" });
});

test("banner item: variants, Copy ID and dismiss", async () => {
  const base = { id: "m1", command: "/feedback", createdAt: "t" };
  const up = feedbackBannerItem({ ...base, status: "uploading" }, () => {})!;
  expect(up.variant).toBe("info");
  expect(up.dismissLabel).toBeUndefined();
  let copied = "";
  const sent = feedbackBannerItem({ ...base, status: "sent", feedbackId: "abc" }, () => {}, async (text) => { copied = text; })!;
  expect(sent.variant).toBe("success");
  expect(sent.dismissLabel).toBe("Dismiss feedback notice");
  expect(sent.actions.map((a) => a.label)).toEqual(["Copy ID"]);
  sent.actions[0].run();
  await Promise.resolve();
  expect(copied).toBe("abc");
  expect(feedbackBannerItem({ ...base, status: "failed", errorMessage: "x" }, () => {})!.variant).toBe("error");
  expect(feedbackBannerItem({ ...base, status: "interrupted" }, () => {})).toBeNull();
});
