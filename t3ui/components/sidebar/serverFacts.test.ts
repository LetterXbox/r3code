import { expect, test } from "nsh/test";
import { factsFromConfig, hostedThreadLink, isScratchProjectPath } from "./serverFacts";

test("a thread link names the environment and the thread on the hosted app", () => {
  expect(hostedThreadLink("env-1", "thread-9")).toBe("https://app.t3.codes/threads/env-1/thread-9");
  expect(hostedThreadLink("env 1", "t.1")).toBe("https://app.t3.codes/threads/env%201/t%2E1");
});

test("the scratch project is the one whose folder is the server's scratch root", () => {
  expect(isScratchProjectPath("/data/scratch", "/data/scratch")).toBe(true);
  expect(isScratchProjectPath("/data/scratch/", "/data/scratch")).toBe(true);
  expect(isScratchProjectPath("/data/other", "/data/scratch")).toBe(false);
  expect(isScratchProjectPath(undefined, "/data/scratch")).toBe(false);
  expect(isScratchProjectPath("/data/scratch", null)).toBe(false);
});

test("the facts come out of the server config", () => {
  expect(factsFromConfig({
    scratchWorkspaceRoot: "/data/scratch",
    environment: { environmentId: "env-1", capabilities: { threadAutoSettleOptOut: true, threadProjectFromScratch: true } },
  })).toEqual({ scratchRoot: "/data/scratch", autoSettleOptOut: true, projectFromScratch: true, environmentId: "env-1" });
  expect(factsFromConfig(null)).toEqual({ scratchRoot: null, autoSettleOptOut: false, projectFromScratch: false, environmentId: null });
  expect(factsFromConfig({ environment: { capabilities: {} } }).autoSettleOptOut).toBe(false);
});
