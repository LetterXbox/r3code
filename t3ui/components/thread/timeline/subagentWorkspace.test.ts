import { expect, test } from "nsh/test";
import { subagentWorkspaceRows } from "./subagentWorkspace";

test("a subagent's hover card names its project and worktree only where they differ from the parent's", () => {
  const projects = [{ id: "p1", name: "App", path: "/repo/app" }, { id: "p2", name: "Docs", path: "/repo/docs" }];
  expect(subagentWorkspaceRows({ projectId: "p1" }, { projectId: "p1" }, projects)).toEqual([]);
  expect(subagentWorkspaceRows({ projectId: "p1" }, { projectId: "p1", path: "/wt/feature-x/" }, projects)).toEqual([{ label: "Worktree", value: "feature-x" }]);
  expect(subagentWorkspaceRows({ projectId: "p1" }, { projectId: "p2" }, projects)).toEqual([{ label: "Project", value: "Docs" }, { label: "Workspace", value: "docs" }]);
});

test("a child on its own branch shows the branch, and the effort comes from its model selection", async () => {
  const { subagentEffort } = await import("./subagents");
  expect(subagentWorkspaceRows({ projectId: "p1" }, { projectId: "p1", path: "/wt/x", branch: "feat/x" }, [{ id: "p1", name: "App", path: "/repo" }])).toEqual([{ label: "Branch", value: "feat/x" }]);
  expect(subagentEffort({ instanceId: "codex", model: "gpt", options: [{ id: "fastMode", value: true }, { id: "reasoningEffort", value: "high" }] })).toBe("high");
  expect(subagentEffort(undefined)).toBe(null);
});
