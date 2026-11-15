import { expect, test } from "nsh/test";
import { parseContextRecords, pullRequestChipKind, pullRequestKindLabel } from "./contextChips";

const pr = (state: string, isDraft = false) => ({ number: 42, title: "Fix it", url: "https://github.com/o/r/pull/42", state, isDraft, headBranch: "feat", baseBranch: "main" });

test("a pull-request context record keeps its metadata", () => {
  const records = parseContextRecords({ records: [{ contextId: "c1", kind: "review-comment", label: "", sectionId: "pull-request:42", filePath: "PR #42", rangeLabel: "", text: "", diff: "", pullRequest: pr("merged") }] });
  expect(records.c1.pullRequest?.number).toBe(42);
  expect(records.c1.pullRequest?.state).toBe("merged");
});

test("the chip's accent and kind label follow the PR state (PULL_REQUEST_CHIP_KINDS, pullRequestContextKindLabel)", () => {
  expect(pullRequestChipKind(pr("open"))).toBe("pr-open");
  expect(pullRequestChipKind(pr("open", true))).toBe("pr-draft");
  expect(pullRequestChipKind(pr("merged"))).toBe("pr-merged");
  expect(pullRequestChipKind(pr("closed"))).toBe("pr-closed");
  expect(pullRequestKindLabel(pr("open", true))).toBe("Draft pull request");
  expect(pullRequestKindLabel({ ...pr("merged"), url: "https://gitlab.com/o/r/-/merge_requests/1" })).toBe("Merged merge request");
});
