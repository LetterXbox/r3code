import { expect, test } from "nsh/test";
import {
  canEditChangeRequest, filterReviewerCandidates, offHeadCheckoutToast, parseReviewerCandidates, reviewerPickerGate, reviewerRequestTitle, reviewerTruncationLabel,
} from "./pullRequestEditing.logic";

test("the title is editable when the host allows it, to the author or someone who can merge", () => {
  const base = { capabilities: { edit: { changeRequest: true } }, viewerPermissions: { actions: [] as string[] }, viewer: "mona", author: { login: "Mona" } };
  expect(canEditChangeRequest(base)).toBe(true);
  expect(canEditChangeRequest({ ...base, viewer: "other" })).toBe(false);
  expect(canEditChangeRequest({ ...base, viewer: "other", viewerPermissions: { actions: ["merge"] } })).toBe(true);
  expect(canEditChangeRequest({ ...base, viewerPermissions: { actions: [], editChangeRequest: false } })).toBe(false);
  expect(canEditChangeRequest({ ...base, capabilities: { edit: { changeRequest: false } } })).toBe(false);
});

test("the reviewer picker needs request and list support, and write access to be usable", () => {
  expect(reviewerPickerGate({ capabilities: { reviewers: { request: true, listCandidates: true, searchCandidates: true } }, viewerPermissions: { requestReviewers: true } })).toEqual({ available: true, allowed: true, searchable: true });
  expect(reviewerPickerGate({ capabilities: { reviewers: { request: true } } }).available).toBe(false);
  expect(reviewerPickerGate({}).allowed).toBe(false);
});

test("candidates parse, narrow by login or name, and say when the list is partial", () => {
  const { candidates, truncated } = parseReviewerCandidates({ candidates: [{ id: "1", kind: "user", login: "hubot", isRequested: true }, { id: "2", login: "mona", name: "Mona Lisa" }, { login: "no-id" }], truncated: true });
  expect(candidates.map((c) => c.login)).toEqual(["hubot", "mona"]);
  expect(truncated).toBe(true);
  expect(filterReviewerCandidates(candidates, "lisa").map((c) => c.login)).toEqual(["mona"]);
  expect(filterReviewerCandidates(candidates, " ").length).toBe(2);
  expect(reviewerTruncationLabel(false, false, "")).toBeNull();
  expect(reviewerTruncationLabel(true, true, "")).toBe("This repository has more people with access than are listed here. Search to find them.");
  expect(reviewerTruncationLabel(true, true, "mo")).toBe("More people match than the host returned. Keep typing to narrow it down.");
  expect(() => parseReviewerCandidates({})).toThrow();
});

test("review request titles and the off-head checkout warning use the web's copy", () => {
  expect(reviewerRequestTitle({ login: "mona", isRequested: false }, true)).toBe("Review requested from mona");
  expect(reviewerRequestTitle({ login: "mona", isRequested: true }, true)).toBe("Review request to mona taken back");
  expect(reviewerRequestTitle({ login: "mona", isRequested: false }, false)).toBe("Could not ask mona for a review");
  expect(offHeadCheckoutToast("pull request").title).toBe("Checked out, but not confirmed on the latest commit");
});
