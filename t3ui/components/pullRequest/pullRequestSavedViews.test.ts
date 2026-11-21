import { expect, test } from "nsh/test";
import { pullRequestViewMatches, pullRequestViewNameError, readPullRequestSavedViews, writePullRequestSavedViews } from "./pullRequestSavedViews";

test("validates view names, matches preferences independent of label order, and round-trips storage (#29387)", () => {
  const existing = [{ id: "v1", name: "Review Queue", preferences: { involvement: "reviewing" as const, state: "open" as const, labels: ["bug", "urgent"] } }];
  expect(pullRequestViewNameError("   ", existing)).toBe("Enter a name for this view.");
  expect(pullRequestViewNameError("review queue", existing)).toBe("A view with this name already exists.");
  expect(pullRequestViewNameError("review queue", existing, "v1")).toBeNull();
  expect(pullRequestViewMatches(existing[0]!, { involvement: "reviewing", state: "open", labels: ["urgent", "bug"] })).toBe(true);
  const raw = writePullRequestSavedViews(existing);
  expect(readPullRequestSavedViews(raw)).toEqual(existing);
});
