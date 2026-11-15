import { expect, test } from "nsh/test";
import { attachPullRequest, attachedPullRequests, pullRequestContextRecord, pullRequestMarker, settleSendContext, textWithMarkers } from "./contextChips";

const pr = { number: 12, title: "Fix login", url: "https://github.com/o/r/pull/12", headBranch: "fix", baseBranch: "main", state: "open" as const, isDraft: false };

test("an inline pull request token sends its marker once, as the prompt holds it, with its record", () => {
  attachPullRequest("t1", pr);
  const record = pullRequestContextRecord(pr);
  const prompt = `review ${pullRequestMarker(record)} please`;
  const missing = settleSendContext("t1", prompt, new Set([record.contextId]));
  expect(missing).toBe("");
  expect(textWithMarkers(prompt, missing)).toBe(prompt);
  expect(attachedPullRequests("t1").map((item) => item.contextId)).toEqual([record.contextId]);
});

test("deleting the token drops the reference from the send", () => {
  attachPullRequest("t2", pr);
  const record = pullRequestContextRecord(pr);
  expect(settleSendContext("t2", "review please", new Set([record.contextId]))).toBe("");
  expect(attachedPullRequests("t2")).toEqual([]);
});
