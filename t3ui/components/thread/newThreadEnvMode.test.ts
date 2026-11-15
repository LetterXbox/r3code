import { expect, test } from "nsh/test";
import { projectFileEnvMode, resolveConfiguredEnvMode, resolveNewThreadEnvMode } from "./newThreadEnvMode";

test("project override, then environment, then t3.json, then local; the file is read only when needed", async () => {
  let reads = 0;
  const file = (contents: string | null) => async () => { reads += 1; return contents; };
  expect(await resolveConfiguredEnvMode({ override: "worktree", environment: "local", readFile: file(null) })).toEqual({ mode: "worktree", source: "project" });
  expect(await resolveConfiguredEnvMode({ override: undefined, environment: "worktree", readFile: file(null) })).toEqual({ mode: "worktree", source: "environment" });
  expect(reads).toBe(0);
  expect(await resolveConfiguredEnvMode({ override: undefined, environment: null, readFile: file('{ "defaultThreadEnvMode": "worktree", // comment\n }') })).toEqual({ mode: "worktree", source: "t3.json" });
  expect(await resolveConfiguredEnvMode({ override: null, environment: null, readFile: file(null) })).toEqual({ mode: "local", source: "environment" });
  expect(await resolveConfiguredEnvMode({ override: null, environment: null, readFile: async () => { throw new Error("offline"); } })).toEqual({ mode: "local", source: "environment" });
  expect(projectFileEnvMode('{"defaultThreadEnvMode":"elsewhere"}')).toBe(undefined);
});

test("a project directly under the new-projects root starts local until its first thread, unless the project or t3.json chose", () => {
  const base = { mode: "worktree" as const, source: "environment" as const, newProjectsRoot: "/Users/me/T3 Projects/", projectHasThreads: false };
  expect(resolveNewThreadEnvMode({ ...base, workspaceRoot: "/Users/me/T3 Projects/demo" })).toBe("local");
  expect(resolveNewThreadEnvMode({ ...base, workspaceRoot: "/Users/me/T3 Projects/demo/sub" })).toBe("worktree");
  expect(resolveNewThreadEnvMode({ ...base, workspaceRoot: "/Users/me/elsewhere/demo" })).toBe("worktree");
  expect(resolveNewThreadEnvMode({ ...base, workspaceRoot: "/Users/me/T3 Projects/demo", projectHasThreads: true })).toBe("worktree");
  expect(resolveNewThreadEnvMode({ ...base, source: "t3.json", workspaceRoot: "/Users/me/T3 Projects/demo" })).toBe("worktree");
  expect(resolveNewThreadEnvMode({ ...base, newProjectsRoot: "C:\\Projects", workspaceRoot: "c:/projects/demo" })).toBe("local");
});
