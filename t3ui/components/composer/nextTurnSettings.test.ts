import { expect, test } from "nsh/test";
import { nextTurnSettingsCommands } from "./nextTurnSettings";

const server = { runtime: "full-access", interaction: "default", branch: "feature" };

test("nothing to persist when the composer matches the thread", () => {
  expect(nextTurnSettingsCommands({ threadId: "t", server, runtime: "full-access", interaction: "default" })).toEqual([]);
  expect(nextTurnSettingsCommands({ threadId: "t", server, runtime: "full-access", interaction: "default", checkoutBranch: "feature" })).toEqual([]);
});

test("a moved checkout, then the modes, in the reference order", () => {
  expect(nextTurnSettingsCommands({ threadId: "t", server, runtime: "approval-required", interaction: "plan", checkoutBranch: "main" })).toEqual([
    { type: "thread.metadata.update", threadId: "t", branch: "main", worktreePath: null },
    { type: "thread.runtime-mode.set", threadId: "t", runtimeMode: "approval-required" },
    { type: "thread.interaction-mode.set", threadId: "t", interactionMode: "plan" },
  ]);
});
