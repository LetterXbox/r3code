import { expect, test } from "nsh/test";
import { createThreadActivityAnnouncer } from "./threadActivityAnnouncement";

test("a turn is announced once as Working, its approval once, and its ending; a thread's first state is silent", () => {
  const heard: string[] = [];
  const step = createThreadActivityAnnouncer((message) => heard.push(message));
  step("t1", { status: "idle", requestId: null, runId: "r0", runStatus: "completed" });
  step("t1", { status: "working", requestId: null, runId: "r1", runStatus: "running" });
  step("t1", { status: "working", requestId: null, runId: "r1", runStatus: "running" });
  step("t1", { status: "approval", requestId: "a1", runId: "r1", runStatus: "waiting" });
  step("t1", { status: "approval", requestId: "a1", runId: "r1", runStatus: "waiting" });
  step("t1", { status: "working", requestId: null, runId: "r1", runStatus: "running" });
  step("t1", { status: "idle", requestId: null, runId: "r1", runStatus: "failed" });
  step("t2", { status: "working", requestId: null, runId: "r9", runStatus: "running" });
  expect(heard).toEqual(["Working", "Needs approval", "Failed"]);
});
