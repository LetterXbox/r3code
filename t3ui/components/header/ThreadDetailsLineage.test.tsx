import { expect, open, test } from "nsh/test";

const size = { width: 900, height: 1100, platform: "macos" } as const;

test("a family-only completed subagent appears among previous agents", async () => {
  const app = await open("./ThreadDetailsLineageFixture.tsx", size);
  await app.waitFor("label:Previous agents");
  await app.press("label:Previous agents");
  await app.waitFor("label:Earlier helper");
  await app.press("text:Remove family child");
  await app.waitUntil(() => !app.shows("label:Earlier helper"));
});

test("updating the current thread keeps previous agents expanded without refetching", async () => {
  const app = await open("./ThreadDetailsLineageFixture.tsx", size);
  await app.waitFor("label:Previous agents");
  await app.press("label:Previous agents");
  await app.waitFor("label:Earlier helper");
  await app.wait(1200);
  await expect(app.texts()).toContain("Updated fork");
  await expect(app.shows("label:Earlier helper")).toBe(true);
  const log = app.texts().join("|");
  expect(log.split("request:orchestration.getThreadFamily:").length - 1).toBe(1);
});

test("an authoritative shell snapshot reads a fresh family", async () => {
  const app = await open("./ThreadDetailsLineageFixture.tsx", size);
  await app.waitFor("label:Previous agents");
  await app.press("label:Previous agents");
  await app.waitFor("label:Earlier helper");
  await app.waitUntil(() => app.texts().join("|").split("request:orchestration.getThreadFamily:").length - 1 === 2);
  await app.waitFor("label:Previous agents");
  await app.waitFor("label:Refreshed helper");
  expect(app.shows("label:Earlier helper")).toBe(false);
});

test("a delegated thread names the parent agent and the environment it runs on, and explains why it cannot open", async () => {
  const app = await open("./ThreadDetailsLineageFixture.tsx", size);
  await app.waitFor("label:Delegating agent");
  await expect(app.texts()).toContain("on Work Mac");
});

test("the fork's source row is split: Merge back is on while a run finished, and runs thread.merge_back", async () => {
  const app = await open("./ThreadDetailsLineageFixture.tsx", size);
  await app.waitFor("label:Merge back to Plan the work");
  await app.press("label:Merge back to Plan the work");
  await app.wait(100);
  const log = app.texts().join("|");
  await expect(log).toContain('"type":"thread.merge_back"');
  await expect(log).toContain('"sourceThreadId":"fork-1","targetThreadId":"source","sourcePoint":{"type":"run","runId":"run-1"}');
});

test("a workflow shows its name, expands into phases and agents, and stops as a whole", async () => {
  const app = await open("./ThreadDetailsLineageFixture.tsx", size);
  await app.waitFor("label:Expand Parallel review");
  await expect(app.shows("label:Survey phase")).toBe(false);
  await app.press("label:Expand Parallel review");
  await app.waitFor("label:Collapse Survey phase, running");
  await expect(app.texts()).toContain("1/2 agents");
  await expect(app.shows("label:Open Read the diff chat")).toBe(true);
  await expect(app.shows("label:Open Check tests chat")).toBe(true);
  await app.hover("label:Parallel review");
  await app.press("label:Stop workflow Parallel review");
  await app.wait(100);
  await expect(app.texts().join("|")).toContain('request:orchestration.stopWorkflow:{"threadId":"fork-1","subagentId":"wf-1"}');
});

test("a running app-owned subagent reveals Stop on hover and stops its task and child thread", async () => {
  const app = await open("./ThreadDetailsLineageFixture.tsx", size);
  await app.waitFor("label:Helper");
  await expect(app.shows("label:Stop subagent Helper")).toBe(false);
  await app.hover("label:Helper");
  await app.press("label:Stop subagent Helper");
  await app.wait(100);
  const log = app.texts().join("|");
  await expect(log).toContain('"type":"subagent.stop"');
  await expect(log).toContain('"type":"thread.stop"');
});

test("a Linux environment row uses its own mark", async () => {
  const app = await open("./ThreadDetailsLineageFixture.tsx", size);
  await app.waitFor("text:OzBook M3");
  await expect(app.shows("text:OzBook M3")).toBe(true);
});
