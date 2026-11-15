import { expect, test } from "nsh/test";
import { effect } from "nsh";
import { createWorkspaceSnapshotRefresher, INITIAL_SNAPSHOT_REFRESH, planSnapshotRefresh, skillsForCwd, slashCommandsForCwd, snapshotScanning, WORKSPACE_SNAPSHOT_TTL_MS } from "./workspaceSkills";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const provider = (snapshot?: Record<string, unknown>) => ({
  instanceId: "codex", skills: [{ name: "global", path: "/g" }], slashCommands: [{ name: "g" }],
  ...(snapshot ? { workspaceSnapshots: [{ cwd: "/repo", ...snapshot }] } : {}),
});

test("workspace skills: the cwd snapshot wins, else the provider's lists", () => {
  const fresh = provider({ checkedAt: new Date(NOW).toISOString(), skills: [{ name: "repo", path: "/r" }], slashCommands: [{ name: "r" }] });
  expect(skillsForCwd(fresh, "/repo")).toEqual([{ name: "repo", path: "/r" }]);
  expect(slashCommandsForCwd(fresh, "/repo")).toEqual([{ name: "r" }]);
  expect(skillsForCwd(fresh, "/other")).toEqual([{ name: "global", path: "/g" }]);
  expect(skillsForCwd(fresh, null)).toEqual([{ name: "global", path: "/g" }]);
});

test("workspace skills: scans when missing or stale, not while current or inside the TTL", () => {
  expect(planSnapshotRefresh(INITIAL_SNAPSHOT_REFRESH, provider(), "/repo", NOW).refresh).toBe(true);
  const current = provider({ checkedAt: new Date(NOW - 1000).toISOString() });
  expect(planSnapshotRefresh(INITIAL_SNAPSHOT_REFRESH, current, "/repo", NOW).refresh).toBe(false);
  const stale = provider({ checkedAt: new Date(NOW - WORKSPACE_SNAPSHOT_TTL_MS - 1).toISOString() });
  const first = planSnapshotRefresh(INITIAL_SNAPSHOT_REFRESH, stale, "/repo", NOW);
  expect(first.refresh).toBe(true);
  expect(planSnapshotRefresh(first.state, stale, "/repo", NOW + 10).refresh).toBe(false);
  expect(snapshotScanning(planSnapshotRefresh(INITIAL_SNAPSHOT_REFRESH, provider(), "/repo", NOW).state)).toBe(true);
});

test("workspace skills: refresher requests once, then cools down after a failed scan", async () => {
  let clock = NOW;
  const calls: string[] = [];
  const refresher = createWorkspaceSnapshotRefresher({ now: () => clock, request: async (instanceId, cwd) => { calls.push(`${instanceId}:${cwd}`); throw new Error("offline"); } });
  refresher.check("codex", "/repo", provider());
  expect(refresher.scanning("codex", "/repo")).toBe(true);
  refresher.check("codex", "/repo", provider());
  await Promise.resolve(); await Promise.resolve();
  expect(calls).toEqual(["codex:/repo"]);
  expect(refresher.scanning("codex", "/repo")).toBe(false);
  clock += 5_000;
  refresher.check("codex", "/repo", provider());
  expect(calls.length).toBe(1);
  clock += 6_000;
  refresher.check("codex", "/repo", provider());
  expect(calls.length).toBe(2);
});

test("typing with an unchanged fresh snapshot does not invalidate the scanning state", () => {
  const refresher = createWorkspaceSnapshotRefresher({ now: () => NOW, request: async () => undefined });
  const current = provider({ checkedAt: new Date(NOW).toISOString() });
  refresher.check("codex", "/repo", current);
  let reads = 0;
  effect(() => { refresher.scanning("codex", "/repo"); reads += 1; });
  const before = reads;
  for (let i = 0; i < 10; i++) refresher.check("codex", "/repo", current);
  expect(reads).toBe(before);
});
