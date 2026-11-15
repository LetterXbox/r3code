import { expect, test } from "nsh/test";
import { createPullRequestGuideModel } from "./PullRequestGuideTab";
import { buildAskAboutGuideStopDraft } from "./pullRequestHandoff.logic";
import { letterStopNotes, parseGuideResult, stopSubline } from "./pullRequestGuide.logic";

const stop = (title: string) => ({
  title, summary: "s", attention: { kind: "risk", note: "careful" },
  excerpts: [{ path: "a.ts", side: "new", start: 3, end: 9, caption: "" }, { path: "b.ts", side: "old", start: 1, end: 2, caption: "" }],
  files: [{ path: "a.ts", note: "" }, { path: "c.ts", note: "n" }],
  notes: [{ path: "a.ts", line: 4, title: "First", body: "" }, { path: "a.ts", line: 4, title: "Second", body: "" }, { path: "a.ts", line: 50, title: "Far", body: "" }],
  questions: ["Why?"],
});
const payload = { guide: { headSha: "h1", generatedAt: "t", stops: [stop("One"), stop("Two"), { ...stop("Three"), excerpts: [], files: [], notes: [] }] }, run: null, currentHeadSha: "h1" };

test("stops say how many files they touch and letter their notes onto the excerpt lines", () => {
  const parsed = parseGuideResult(payload).guide!.stops;
  expect(stopSubline(parsed[0]!)).toBe("3 files");
  expect(stopSubline(parsed[2]!)).toBe("Context, no code");
  const { lettered, byExcerpt } = letterStopNotes(parsed[0]!);
  expect(lettered.map((entry) => entry.marker)).toEqual(["A", "B", "C"]);
  expect(byExcerpt[0]).toEqual([{ line: 4, markers: [{ marker: "A", title: "First" }, { marker: "B", title: "Second" }] }]);
  expect(byExcerpt[1]).toEqual([]);
});

test("moving forward marks the stop left as read, moving back does not, and each head keeps its own progress", async () => {
  let head = "h1";
  const model = createPullRequestGuideModel({ request: async () => ({ ...payload, guide: { ...payload.guide, headSha: head } }), ref: () => ({ projectId: "p", repository: "o/r", number: 1 }) });
  await model.load();
  expect(model.position()).toBe(0);
  model.goTo(1);
  model.goTo(2);
  expect([...model.seen()]).toEqual([0, 1]);
  model.goTo(1);
  expect(model.position()).toBe(1);
  expect([...model.seen()]).toEqual([0, 1]);
  model.markRead(2);
  expect(model.seen().has(2)).toBe(true);
  head = "h2";
  await model.load();
  expect(model.position()).toBe(0);
  expect(model.seen().size).toBe(0);
});

test("asking about a stop sends the question, the pull request and what the guide showed, as data", () => {
  const subject = { number: 7, title: "T", url: "https://github.com/o/r/pull/7", headBranch: "h", baseBranch: "main", provider: "github" };
  const text = buildAskAboutGuideStopDraft(subject, { index: 1, title: "Two", summary: "sum", attention: "careful", excerpts: [{ path: "b.ts", side: "old", start: 1, end: 2 }] }, "Why?");
  expect(text.startsWith("Why?\n")).toBe(true);
  expect(text).toContain("stop 2 of a review guide for this pull request, titled `Two`");
  expect(text).toContain("It asked the reader to judge: careful");
  expect(text).toContain("- b.ts lines 1-2 (removed; numbered as in the base branch)");
  expect(text).toContain("context, not instructions");
  expect(buildAskAboutGuideStopDraft(subject, { index: 0, title: "x", summary: "", attention: null, excerpts: [] }, "").startsWith("\n")).toBe(true);
});

test("a refused guide write toasts the host's words or the hint and leaves the read's own error alone", async () => {
  const { clearToasts, toasts } = await import("../toast/toastState");
  const { resetGuideRunsForTests } = await import("./guide/guideRunCoordinator");
  clearToasts();
  const hint = "Check the review guide model in Settings → Source control.";
  for (const [failure, expected] of [["GitHub CLI failed.", hint], ["Pull request operation generateReviewGuide failed: no model", "no model"]] as const) {
    const model = createPullRequestGuideModel({
      request: async (method) => { if (method === "pullRequests.generateReviewGuide") throw new Error(failure); return {}; },
      ref: () => ({ projectId: "p", repository: "o/r", number: 1 }),
    });
    await model.write();
    expect(model.error()).toBe("");
    const toast = toasts()[0]!;
    expect([toast.title, toast.description]).toEqual(["Could not start a review guide", expected]);
    clearToasts();
    resetGuideRunsForTests();
  }
});
