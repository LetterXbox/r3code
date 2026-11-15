import { expect, test } from "nsh/test";
import { rememberedPullRequestTab, rememberPullRequestTab } from "./pullRequestTabMemory";

test("fm13: each pull-request tab remembers its detail tab", () => {
  expect(rememberedPullRequestTab("pull-request:o/r#1")).toBeNull();
  rememberPullRequestTab("pull-request:o/r#1", "code");
  rememberPullRequestTab("pull-request:o/r#2", "timeline");
  expect(rememberedPullRequestTab("pull-request:o/r#1")).toBe("code");
  expect(rememberedPullRequestTab("pull-request:o/r#2")).toBe("timeline");
});
