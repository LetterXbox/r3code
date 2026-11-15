import { expect, test } from "nsh/test";
import { breakdownRows, parseChangeBreakdown } from "./PullRequestChangeBreakdownStat";

test("the split lists the kinds that changed, in the reference's order, and an old server's missing docs count as none", () => {
  const breakdown = parseChangeBreakdown({ code: { additions: 10, deletions: 2 }, tests: { additions: 0, deletions: 0 }, mocks: { additions: 1, deletions: 0 }, generated: { additions: 0, deletions: 5 } });
  expect(breakdownRows(breakdown!)).toEqual([
    { label: "Code", additions: 10, deletions: 2 },
    { label: "Mocks", additions: 1, deletions: 0 },
    { label: "Generated", additions: 0, deletions: 5 },
  ]);
  expect(parseChangeBreakdown(null)).toBe(null);
});

test("a GitHub Actions run waiting for approval reads Awaiting approval", async () => {
  const { checkStatusLabel } = await import("./pullRequestDetail.logic");
  expect(checkStatusLabel({ status: "action-required", url: "https://github.com/o/r/actions/runs/12" })).toBe("Awaiting approval");
  expect(checkStatusLabel({ status: "action-required", url: "" })).not.toBe("Awaiting approval");
});
