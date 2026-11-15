import { expect, test } from "nsh/test";
import { pullRequestEmptyState, pullRequestListFailed } from "./commandItems";

test("the # menu's empty line follows useComposerMenuItems", () => {
  expect(pullRequestEmptyState({ available: false, failed: false, query: "" })).toBe("Pull requests are not available for this project.");
  expect(pullRequestEmptyState({ available: true, failed: true, query: "x" })).toBe("Pull requests could not be read for this project.");
  expect(pullRequestEmptyState({ available: true, failed: false, query: "queue" })).toBe("No pull request matches queue.");
  expect(pullRequestEmptyState({ available: true, failed: false, query: "" })).toBe("No pull requests found in this repository.");
});

test("a PullRequestListResult error for this project counts as unreadable", () => {
  expect(pullRequestListFailed({ entries: [], errors: [{ projectId: "p1", message: "gh failed" }] }, "p1")).toBe(true);
  expect(pullRequestListFailed({ entries: [], errors: [{ projectId: "p2", message: "gh failed" }] }, "p1")).toBe(false);
  expect(pullRequestListFailed({ entries: [] }, "p1")).toBe(false);
});
