import { expect, test } from "nsh/test";
import { attachPullRequest, attachedPullRequests, extraContextMarker, inlineContextIds, pullRequestContextRecord, pullRequestMarker, replyPrompt, sendExtrasFor, settleSendContext, textWithMarkers, type ResponseContextRecord } from "./contextChips";

const pr = { number: 12, title: "Fix login", url: "https://github.com/o/r/pull/12", headBranch: "fix", baseBranch: "main", state: "open" as const, isDraft: false };

test("replying attaches one bounded response and preserves the draft", () => {
  const source = { environmentId: "env", threadId: "thread", messageId: "first", itemId: "item-1", body: "  " + "x".repeat(299) + "💡 tail",
    subagents: [{ environmentId: "remote", threadId: "helper", title: "Helper [result]" }] };
  const prompt = replyPrompt("thread", "My draft", source);
  const initial = sendExtrasFor("thread").context?.records[0] as ResponseContextRecord;
  expect(initial.citation.text).toBe("x".repeat(299));
  expect(initial.itemId).toBe("item-1");
  expect(initial.subagents).toEqual([{ environmentId: "remote", threadId: "helper", title: "Helper result" }]);
  expect(replyPrompt("thread", prompt, source)).toBe(prompt);
  const replaced = replyPrompt("thread", prompt, { ...source, messageId: "second", itemId: "item-2", body: "Another response" });
  const records = sendExtrasFor("thread").context?.records as ResponseContextRecord[];
  expect(records.map((record) => record.itemId)).toEqual(["item-2"]);
  expect(replaced).toBe(`${extraContextMarker(records[0]!)} My draft`);
  expect(settleSendContext("thread", replaced, inlineContextIds)).toBe("");
  expect(settleSendContext("thread", "My draft", inlineContextIds)).toBe("");
  expect(sendExtrasFor("thread").context).toBe(undefined);
});

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
