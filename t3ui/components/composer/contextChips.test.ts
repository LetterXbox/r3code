import { expect, test } from "nsh/test";
import { attachPullRequest, chipsFor, clearSendContext, contextMarker, detachPullRequest, pullRequestContextRecord, rememberMention, removeMentionToken, sendContextFor, sendExtrasFor, textWithMarkers, toComposerContextId } from "./contextChips";

const pr = { number: 12, title: "Fix the queue", url: "https://github.com/acme/app/pull/12", headBranch: "fix/queue", baseBranch: "main", state: "open", isDraft: false };

test("a pull request becomes a review-comment record whose id is a safe slug with a digest", () => {
  const record = pullRequestContextRecord(pr);
  expect(record.kind).toBe("review-comment");
  expect(record.label).toBe("#12");
  expect(record.sectionId).toBe("pull-request:12");
  expect(record.pullRequest).toMatchObject({ number: 12, headBranch: "fix/queue", baseBranch: "main", state: "open" });
  expect(record.text).toContain("The pull request is #12, titled `Fix the queue`");
  expect(record.contextId).toMatch(/^[a-z0-9_-]{1,128}$/i);
  expect(pullRequestContextRecord(pr).contextId).toBe(record.contextId);
  expect(toComposerContextId("plain_id-1")).toBe("plain_id-1");
  expect(pullRequestContextRecord({ ...pr, url: "https://gitlab.com/a/b/-/merge_requests/3" }).text).toContain("The merge request is");
});

test("attached references ride the send as context records plus a marker appended to the text", () => {
  attachPullRequest("t1", pr);
  attachPullRequest("t1", pr);
  const { records, markers } = sendContextFor("t1");
  expect(records.length).toBe(1);
  expect(markers).toBe(contextMarker("review-comment", records[0]!.contextId, "#12"));
  expect(markers.startsWith("[#12](t3-context://v1/review-comment/")).toBe(true);
  expect(textWithMarkers("look at this", markers)).toBe(`look at this ${markers}`);
  expect(textWithMarkers("", markers)).toBe(markers);
  expect(sendExtrasFor("t1").context?.records.length).toBe(1);
  expect(chipsFor("t1", "")[0]).toMatchObject({ kind: "pull-request", label: "#12", detail: "Fix the queue" });
  detachPullRequest("t1", records[0]!.contextId);
  expect(sendExtrasFor("t1")).toEqual({});
  attachPullRequest("t1", pr);
  clearSendContext("t1");
  expect(chipsFor("t1", "")).toEqual([]);
});

test("file and skill mentions show as chips only while the prompt still names them", () => {
  rememberMention("t2", "@src/app.ts", "file");
  rememberMention("t2", "$review", "skill");
  expect(chipsFor("t2", "see @src/app.ts and $review please").map((chip) => [chip.kind, chip.label])).toEqual([["file", "app.ts"], ["skill", "review"]]);
  expect(chipsFor("t2", "see @src/app.ts").map((chip) => chip.label)).toEqual(["app.ts"]);
  expect(removeMentionToken("see @src/app.ts and more", "@src/app.ts")).toBe("see and more");
  expect(removeMentionToken("$review", "$review")).toBe("");
  expect(chipsFor(undefined, "x")).toEqual([]);
});

test("an attachment chip is appended once, removed with its attachment, and becomes a context record on send", async () => {
  const { appendAttachmentReference, attachmentContextRecords, removeAttachmentReference } = await import("./contextChips");
  const item = { id: "a1", kind: "image" as const, name: "shot.png", mimeType: "image/png", sizeBytes: 10, uploadedId: "up-1" };
  const once = appendAttachmentReference("look", item);
  expect(once).toBe("look [shot.png](t3-context://v1/image/image_a1) ");
  expect(appendAttachmentReference(once, item)).toBe(once);
  expect(attachmentContextRecords(once, [item])).toEqual([{ version: 1, contextId: "image_a1", kind: "image", label: "shot.png", attachmentId: "up-1", name: "shot.png", mimeType: "image/png", sizeBytes: 10 }]);
  expect(removeAttachmentReference(once, item)).toBe("look ");
});

test("saved review comments and context records are read back and merged without replacing live ones", async () => {
  const { readSavedContexts, mergeSavedContexts, attachedExtraContexts, attachedPullRequests } = await import("./contextChips");
  const saved = readSavedContexts(JSON.stringify({
    extras: { t1: [{ version: 1, kind: "thread", contextId: "ctx_saved_thread", label: "Old thread", title: "Old" }, { kind: "bogus" }], bad: "x" },
    referenced: { t1: [{ version: 1, kind: "review-comment", contextId: "ctx_saved_pr", label: "#9" }] },
  }));
  expect(Object.keys(saved.extras)).toEqual(["t1"]);
  expect(saved.extras.t1).toHaveLength(1);
  mergeSavedContexts(saved);
  mergeSavedContexts(saved);
  expect(attachedExtraContexts("t1").map((record) => record.contextId)).toEqual(["ctx_saved_thread"]);
  expect(attachedPullRequests("t1").map((record) => record.contextId)).toEqual(["ctx_saved_pr"]);
  expect(readSavedContexts("not json")).toEqual({ extras: {}, referenced: {} });
});
