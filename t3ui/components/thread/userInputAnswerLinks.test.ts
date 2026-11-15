import { expect, test } from "nsh/test";
import { formatThreadLink, projectPendingUserInputAnswer, threadContextsReferencedByAnswer } from "./userInputAnswerLinks";

test("fm13: a thread chip in an answer becomes a thread link; other text and unknown chips stay", () => {
  const records = [{ contextId: "ctx_a", environmentId: "env-1", threadId: "t-9" }];
  expect(projectPendingUserInputAnswer("see [Fix login](t3-context://v1/thread/ctx_a) please", records)).toBe("see [Fix login](t3-thread://v2/env-1/t-9) please");
  expect(projectPendingUserInputAnswer("[x](t3-context://v1/thread/ctx_z)", records)).toBe("[x](t3-context://v1/thread/ctx_z)");
  expect(projectPendingUserInputAnswer(["a"], records)).toEqual(["a"]);
  expect(formatThreadLink({ environmentId: null, threadId: "t1" })).toBe("<t3-thread://v1/t1>");
  expect(threadContextsReferencedByAnswer("[a](t3-context://v1/thread/ctx_a)", [{ contextId: "ctx_a" }, { contextId: "ctx_b" }])).toEqual([{ contextId: "ctx_a" }]);
});
