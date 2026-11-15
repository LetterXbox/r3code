import { expect, test } from "nsh/test";
import { searchScopeNotice } from "./SearchScopeNotice";

test("an auto-settlement target needs a connected environment in the selected scope", () => {
  const environments = [{ environmentId: "a", connected: true }, { environmentId: "b", connected: false }];
  expect(searchScopeNotice("auto-settle-inactive-threads", "environment", { scopeEnvironmentIds: ["b"], environments })).toEqual({
    target: "environment",
    eligibleEnvironmentIds: ["a"],
    message: "Auto-settle inactive threads requires a supporting environment. Choose one to continue.",
  });
  expect(searchScopeNotice("auto-settle-merged-threads", "all", { scopeEnvironmentIds: ["b"], environments: [{ environmentId: "b", connected: false }] })?.message)
    .toBe("Auto-settle merged threads requires a supporting environment. Connect or update an environment to continue.");
  expect(searchScopeNotice("auto-settle-inactive-threads", "all", { scopeEnvironmentIds: ["a", "b"], environments })).toBe(null);
  expect(searchScopeNotice("auto-settle-inactive-threads", "unavailable", { scopeEnvironmentIds: [], environments })).toBe(null);
});
