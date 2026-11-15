import { expect, test } from "nsh/test";
import { parkQuestionAttachments, questionAttachmentKey, questionAttachmentOwner } from "./store";

const q1 = questionAttachmentKey("t", "r1", "q1");
const q2 = questionAttachmentKey("t", "r1", "q2");
const aside = "t\u0000thread-draft";

test("question attachments: each question keeps its own draft and the thread's waits aside", () => {
  let all: Record<string, string[]> = { t: ["thread-file"] };
  all = parkQuestionAttachments(all, "t", aside, q1, null);
  expect(all).toEqual({ [aside]: ["thread-file"], t: [] });
  all = { ...all, t: ["a1"] };
  all = parkQuestionAttachments(all, "t", q1, q2, null);
  expect(all).toEqual({ [aside]: ["thread-file"], [q1]: ["a1"], t: [] });
  all = { ...all, t: ["b1"] };
  all = parkQuestionAttachments(all, "t", q2, q1, null);
  expect(all.t).toEqual(["a1"]);
  expect(all[q2]).toEqual(["b1"]);
});

test("question attachments: no question asked restores the thread draft and drops resolved requests", () => {
  const all = parkQuestionAttachments({ t: ["a1"], [q2]: ["b1"], [aside]: ["thread-file"], [questionAttachmentKey("t", "r2", "x")]: ["keep"] }, "t", q1, aside, new Set(["r2"]));
  expect(all).toEqual({ t: ["thread-file"], [questionAttachmentKey("t", "r2", "x")]: ["keep"] });
});

test("question attachments: after a reload the composer's attachments go back to the question that owned them", () => {
  expect(questionAttachmentOwner("t", undefined, { t: { requestId: "r1", questionId: "q1" } })).toBe(q1);
  expect(questionAttachmentOwner("t", { requestId: "r1", questionId: "q2" }, { t: { requestId: "r1", questionId: "q1" } })).toBe(q2);
  expect(questionAttachmentOwner("t", undefined, {})).toBe(aside);
});
