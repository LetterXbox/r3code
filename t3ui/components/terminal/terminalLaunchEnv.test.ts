import { expect, test } from "nsh/test";
import { projectScriptRuntimeEnv, terminalLaunchFields } from "./terminalLaunchEnv";

test("project runtime env matches packages/shared projectScriptRuntimeEnv", () => {
  expect(projectScriptRuntimeEnv({ projectRoot: "/p", worktreePath: null })).toEqual({ T3CODE_PROJECT_ROOT: "/p" });
  expect(projectScriptRuntimeEnv({ projectRoot: "/p", worktreePath: "/w", extraEnv: { A: "1" } })).toEqual({ T3CODE_PROJECT_ROOT: "/p", T3CODE_WORKTREE_PATH: "/w", A: "1" });
});

test("attach fields carry the worktree path and env", () => {
  expect(terminalLaunchFields({ projectRoot: "/p", worktreePath: "/w" })).toEqual({ worktreePath: "/w", env: { T3CODE_PROJECT_ROOT: "/p", T3CODE_WORKTREE_PATH: "/w" } });
  expect(terminalLaunchFields({ projectRoot: "/p", worktreePath: undefined })).toEqual({ env: { T3CODE_PROJECT_ROOT: "/p" } });
  expect(terminalLaunchFields({ projectRoot: undefined, worktreePath: undefined })).toEqual({});
});

test("a terminal's first attach is opened with terminal.open's input: runtime env plus the script's extra env", async () => {
  const { terminalOpenInput } = await import("./terminalLaunchEnv");
  expect(terminalOpenInput({
    threadId: "t", terminalId: "term-1", cwd: "/p", size: { cols: 100, rows: 30 },
    location: { worktreePath: "/w", env: { T3CODE_PROJECT_ROOT: "/p" } },
    launch: { stopOnSettle: true, env: { PORT: "3000" } },
  })).toEqual({ threadId: "t", terminalId: "term-1", cwd: "/p", worktreePath: "/w", env: { T3CODE_PROJECT_ROOT: "/p", PORT: "3000" }, cols: 100, rows: 30, stopOnSettle: true });
  expect(terminalOpenInput({ threadId: "t", terminalId: "term-1", cwd: "/p", size: { cols: 80, rows: 24 }, location: {}, launch: {} }))
    .toEqual({ threadId: "t", terminalId: "term-1", cwd: "/p", cols: 80, rows: 24 });
});
