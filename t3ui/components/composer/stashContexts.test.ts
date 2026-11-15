import { expect, test } from "nsh/test";
import { attachedExtraContexts, attachedPullRequests, attachExtraContext, attachPullRequest, restoreContextRecords, takeContextRecords, threadContextRecord } from "./contextChips";

test("fm13: stashing takes the thread's context chips and restoring puts them back", () => {
  attachPullRequest("t-stash", { number: 7, title: "Fix", url: "https://h/o/r/pull/7", headBranch: "a", baseBranch: "main", state: "open", isDraft: false });
  attachExtraContext("t-stash", threadContextRecord({ environmentId: "e", threadId: "other" }, "Other"));
  const records = takeContextRecords("t-stash");
  expect(records.length).toBe(2);
  expect(attachedPullRequests("t-stash").length + attachedExtraContexts("t-stash").length).toBe(0);
  restoreContextRecords("t-stash", records);
  expect(attachedPullRequests("t-stash").length).toBe(1);
  expect(attachedExtraContexts("t-stash").length).toBe(1);
});
