import { expect, open, test } from "nsh/test";
import { placeWorktreeSetup, readWorktreeSetupSnapshot, resolveVisibleWorktreeSetup, worktreeSetupHeaderLabel } from "./worktreeSetup";
import type { TimelineRow } from "./workLog";

const snap = (phase: string, agent: string, script = "done") => readWorktreeSetupSnapshot({
  threadId: "t1", phase, startedAt: "2026-01-01T00:00:00Z", endedAt: null, branch: null, baseRef: null, worktreePath: null, setupScript: null,
  stages: [{ id: "setup-script", status: script, startedAt: null, endedAt: null, percent: null, detail: null, tail: [] }, { id: "agent", status: agent, startedAt: null, endedAt: null, percent: null, detail: null, tail: [] }],
  error: null, sequence: 1,
})!;
const user = { kind: "entry", id: "u1", entry: { kind: "message", id: "u1", message: { id: "u1", role: "user", body: "go" } } } as unknown as TimelineRow;
const working = { kind: "working", id: "working", since: null } as TimelineRow;

test("the setup row sits under the working row while setup owns it, and becomes the Background setup chip after handoff", () => {
  expect(placeWorktreeSetup([user, working], snap("running", "pending"), false).rows.map((row) => row.kind)).toEqual(["entry", "working", "worktree-setup"]);
  const handed = placeWorktreeSetup([user, working], snap("running", "done"), true);
  expect(handed.rows.map((row) => row.kind)).toEqual(["entry", "working"]);
  expect(handed.background?.phase).toBe("running");
  expect(placeWorktreeSetup([user], snap("failed", "pending"), false).rows.map((row) => row.kind)).toEqual(["entry", "worktree-setup"]);
  expect(worktreeSetupHeaderLabel(snap("done", "done", "failed"))).toBe("Worktree ready, setup script failed");
  expect(resolveVisibleWorktreeSetup(snap("done", "done"), true)).toBe(null);
  expect(resolveVisibleWorktreeSetup(snap("done", "done", "failed"), true)?.phase).toBe("done");
});

test("the card lists stages, the script's last lines, details, and cancels through worktreeSetup.cancel", async () => {
  const app = await open("./WorktreeSetupFixture.tsx", { width: 900, height: 700 });
  await expect(app.texts()).toContain("Fetch base branch");
  await expect(app.texts()).toContain("Check out files");
  await expect(app.texts()).toContain("Start agent");
  await expect(app.texts()).toContain("linking");
  await expect(app.shows("label:Open terminal")).toBe(true);
  await app.press("label:Details");
  await expect(app.texts()).toContain("t3/feature");
  await expect(app.texts()).toContain("/w/feature");
  await app.press("label:Cancel");
  await app.waitFor('label:worktreeSetup.cancel:{"threadId":"t1"}');
});
