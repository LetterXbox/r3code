import { expect, test } from "nsh/test";
import { guideOutcome, isGuideRunWatched, readGuidePoll, resetGuideRunsForTests, watchGuideRun, type GuideRunWatch } from "./guideRunCoordinator";

const reference = { projectId: "p", repository: "o/r", number: 7 };
const watch: GuideRunWatch = { reference, title: "Add things", previousGuideAt: "2026-01-01T00:00:00Z", previousFailedAt: null, since: 1_000 };

test("an answer is running, a new guide, a new failure, or settles once the run was seen or a minute passed", () => {
  expect(guideOutcome(watch, readGuidePoll({ guide: null, run: { _tag: "Running" } }), false, 2_000)).toEqual({ kind: "running" });
  expect(guideOutcome(watch, readGuidePoll({ guide: { generatedAt: "2026-02-01T00:00:00Z" }, run: null }), true, 2_000)).toEqual({ kind: "announce", failure: null });
  expect(guideOutcome(watch, readGuidePoll({ guide: null, run: { _tag: "Failed", failedAt: "x", detail: "No model" } }), true, 2_000)).toEqual({ kind: "announce", failure: "No model" });
  expect(guideOutcome(watch, readGuidePoll({ guide: { generatedAt: "2026-01-01T00:00:00Z" }, run: null }), false, 2_000)).toEqual({ kind: "wait" });
  expect(guideOutcome(watch, readGuidePoll({ guide: { generatedAt: "2026-01-01T00:00:00Z" }, run: null }), true, 2_000)).toEqual({ kind: "settle" });
  expect(guideOutcome(watch, readGuidePoll({ guide: null, run: null }), false, 70_000)).toEqual({ kind: "settle" });
});

test("a watch polls pullRequests.reviewGuide until the run settles, once per pull request", async () => {
  resetGuideRunsForTests();
  const asked: string[] = [];
  let answers = [{ guide: null, run: { _tag: "Running" } }, { guide: { generatedAt: "2026-03-01T00:00:00Z" }, run: null }];
  const rpc = async (method: string) => { asked.push(method); return answers.shift() ?? { guide: null, run: null }; };
  watchGuideRun(watch, rpc, 20);
  watchGuideRun(watch, rpc, 20);
  expect(isGuideRunWatched(JSON.stringify(["p", null, "o/r", 7]))).toBe(true);
  for (let i = 0; i < 100 && isGuideRunWatched(JSON.stringify(["p", null, "o/r", 7])); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(isGuideRunWatched(JSON.stringify(["p", null, "o/r", 7]))).toBe(false);
  expect(asked).toEqual(["pullRequests.reviewGuide", "pullRequests.reviewGuide"]);
  answers = [];
});
