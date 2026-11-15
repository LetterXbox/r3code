import { expect, test } from "nsh/test";
import { activityFromTurnItem } from "./ingestActivity";

test("an answered user_input_request leads with the question and the answer, and expands to the history", () => {
  const item = { id: "q1", type: "user_input_request", status: "completed", questionAnswer: { requestId: "r", questionTextById: { a: "Which branch?" }, answers: { a: "main" }, attachmentsByQuestionId: { a: [{ id: "f", name: "shot.png", type: "image" }] } } };
  const activity = activityFromTurnItem(item, 1);
  expect(activity?.title).toBe("Which branch? · main");
  expect(activity?.detail).toBe("Which branch?\n  main\n  shot.png");
});

test("an answer with no question text reads Answered questions", () => {
  const activity = activityFromTurnItem({ id: "q2", type: "user_input_request", status: "completed", questionAnswer: { answers: {}, attachmentsByQuestionId: {} } }, 1);
  expect(activity?.title).toBe("Answered questions");
});
