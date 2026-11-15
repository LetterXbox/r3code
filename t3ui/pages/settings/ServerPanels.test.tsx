import { expect, open, test } from "nsh/test";
import { itemSummary, optionValue, parseDiscovery } from "./SourceControlDiscovery";
import { formatBytes, lastRunDescription, parseCleanupReport, parseDatabaseStatus, shouldRecommendCompaction } from "./Storage";

test("Source control says to connect an environment while disconnected", async () => {
  const app = await open("./SourceControlFixture.tsx", { width: 1100, height: 2400 });
  await expect(app.texts()).toContain("Connect an environment to inspect its version control tools and hosting integrations.");
});

test("Source control lists what the server found, with auth state and coming-soon systems", async () => {
  const app = await open("./SourceControlFixture.tsx", { width: 1100, height: 2400 });
  await app.press("label:Connect fixture");
  await app.wait(80);
  for (const text of ["Version Control", "Source control providers", "Git", "2.45.0", "Jujutsu", "Coming Soon", "GitHub", "Authenticated as", "GitLab", "Not available on this server: Install glab."]) await expect(app.texts()).toContain(text);
  await expect(app.shows("id:Source control github (on)")).toBe(true);
  await expect(app.shows("id:Source control gitlab (off)")).toBe(true);
  await expect(app.texts()).toContain("call server.discoverSourceControl");
  await app.press("label:Rescan server environment");
  await app.wait(60);
});

test("Maintenance runs cleanup now and shows the last run, and offers to reclaim database space", async () => {
  const app = await open("./ServerPanelsFixture.tsx", { width: 1100, height: 3000 });
  await app.press("label:Connect fixture");
  await app.wait(80);
  await expect(app.texts()).toContain("Last run 3h ago. 2.5 MB recovered.");
  await expect(app.texts()).toContain("Reclaim freed database space");
  await expect(app.texts()).toContain("t3 doctor --compact");
  await app.press("label:Delete now");
  await app.wait(80);
  await expect(app.texts()).toContain("call server.runStorageCleanup");
  await expect(app.texts()).toContain("Last run just now. 9.0 GB recovered.");
});

test("discovery and storage payloads parse with effect Options, bytes and thresholds", () => {
  expect(optionValue({ _tag: "Some", value: "x" })).toBe("x");
  expect(optionValue({ _tag: "None" })).toBeNull();
  expect(optionValue("y")).toBe("y");
  const found = parseDiscovery({ versionControlSystems: [{ kind: "git", label: "Git", status: "available", implemented: true, version: { _tag: "Some", value: "2" } }], sourceControlProviders: [] });
  expect(itemSummary(found.versionControlSystems[0]!)).toBe("Available");
  expect(formatBytes(1_500)).toBe("1.5 KB");
  expect(parseCleanupReport({ finishedAt: "x", counts: { removed: 1, kept: 2, failed: 1 }, entries: [{ outcome: "failed", reason: "busy" }], bytesFreed: 5 })?.failureReason).toBe("busy");
  expect(lastRunDescription(null, "failed", 0)).toBe("Could not load the last run.");
  expect(lastRunDescription(null, "idle", 0)).toBe("Cleanup hasn't run yet.");
  const status = parseDatabaseStatus({ databaseBytes: 3 * 1024 ** 3, reclaimableBytes: 2 * 1024 ** 3, incrementalVacuumEnabled: false, compactCommand: "c" })!;
  expect(shouldRecommendCompaction(status)).toBe(true);
  expect(shouldRecommendCompaction({ ...status, incrementalVacuumEnabled: true })).toBe(false);
});

test("panels that open while already connected load without waiting for a connect", async () => {
  const maintenance = await open("./ConnectedPanelsFixture.tsx", { width: 1100, height: 3000 });
  await maintenance.wait(120);
  await expect(maintenance.texts()).toContain("Last run 3h ago. 2.5 MB recovered.");
  await expect(maintenance.texts()).toContain("t3 doctor --compact");
  const sourceControl = await open("./ConnectedSourceControlFixture.tsx", { width: 1100, height: 2400 });
  await sourceControl.wait(120);
  await expect(sourceControl.texts()).toContain("Authenticated as");
  await expect(sourceControl.shows("label:Toggle source control account visibility")).toBe(true);
});

test("reclaiming database space asks with the restart warning, then calls the server", async () => {
  const { reclaimDatabaseSpace, databaseReclaimMinutes, formatGiB } = await import("./Storage");
  const status = { databaseBytes: 6 * 1024 ** 3, reclaimableBytes: 2 * 1024 ** 3, incrementalVacuumEnabled: false, compactCommand: "t3 compact", canReclaim: true };
  expect(databaseReclaimMinutes(status)).toBe(2);
  expect(formatGiB(status.reclaimableBytes)).toBe("2.0 GiB");
  const asked: { message: string; confirmLabel?: string }[] = [];
  const calls: string[] = [];
  const ok = await reclaimDatabaseSpace(status, "Mac", { confirm: async (message, options) => { asked.push({ message, confirmLabel: options?.confirmLabel }); return true; }, request: async (method) => { calls.push(method); return {}; } });
  expect(ok).toBe(true);
  expect(asked[0]?.confirmLabel).toBe("Restart and reclaim");
  expect(asked[0]?.message.startsWith("Reclaim 2.0 GiB on Mac?")).toBe(true);
  expect(calls).toEqual(["server.reclaimDatabaseSpace"]);
});

test("a cleanup that fails entries or is rejected is a toast naming the environment", async () => {
  const { runCleanup } = await import("./Storage");
  const { toasts } = await import("../../components/toast/toastState");
  const done = { trigger: "manual", startedAt: "x", finishedAt: "2026-11-11T00:00:00Z", counts: { removed: 0, kept: 0, failed: 1 }, omittedCount: 0, bytesFreed: 0 };
  await runCleanup(async () => ({ ...done, entries: [{ outcome: "failed", reason: "Directory is busy" }] }));
  const failed = toasts().find((toast) => toast.title === "Cleanup failed on this environment");
  expect(failed?.description).toBe("Directory is busy");
  await runCleanup(async () => { throw new Error("Server is restarting"); });
  const rejected = toasts().find((toast) => toast.title === "Could not run cleanup on this environment");
  expect(rejected?.description).toBe("Server is restarting");
});
