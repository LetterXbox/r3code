// SidebarUpdatePill's "everything" entry, provider-only: the summary label, the plan and the run's statuses.
import { expect, test } from "nsh/test";
import { planMachine, runProviderUpdates, updateEverythingSummaryLabel } from "./SidebarUpdateEverythingButton";
import type { ProviderView } from "../../pages/settings/providers/logic";

const provider = (instanceId: string, driver: string, displayName: string | null = null) => ({ instanceId, driver, displayName } as unknown as ProviderView);

test("the tooltip is describeUpdateEverything's summary", () => {
  expect(updateEverythingSummaryLabel(1)).toBe("Update 1 provider");
  expect(updateEverythingSummaryLabel(3)).toBe("Update 3 providers");
});

test("the run updates every provider at once and records done / failed with the reference's fallbacks", async () => {
  const machine = planMachine("This Mac", [provider("codex", "codex", "Codex"), provider("claude", "claudeAgent", "Claude"), provider("x", "opencode", "OpenCode")]);
  expect(machine.providers.map((run) => run.status)).toEqual(["waiting", "waiting", "waiting"]);
  const seen: string[] = [];
  const done = await runProviderUpdates(machine, async ({ instanceId }) => {
    if (instanceId === "codex") return { status: "succeeded" };
    if (instanceId === "claude") return null;
    throw new Error("");
  }, (next) => { seen.push(next.providers.map((run) => run.status).join(",")); });
  expect(seen[0]).toBe("updating,waiting,waiting");
  expect(done.providers).toEqual([
    { instanceId: "codex", driver: "codex", name: "Codex", status: "done", failure: null },
    { instanceId: "claude", driver: "claudeAgent", name: "Claude", status: "failed", failure: "Provider update did not finish." },
    { instanceId: "x", driver: "opencode", name: "OpenCode", status: "failed", failure: "The provider update command could not be started." },
  ]);
});

import { describeUpdateCapsule, formatUpdateElapsed, runFinishedCleanly, runMachineFailure, UPDATE_SLOW_AFTER_MS } from "./updateCapsule";
import { startUpdateEverything } from "./SidebarUpdateEverythingButton";

test("the capsule label follows describeUpdateCapsule", () => {
  const base = planMachine("This Mac", [provider("codex", "codex", "Codex")]);
  const running = { machine: { ...base, providers: [{ ...base.providers[0]!, status: "updating" as const }] }, startedAt: 1000 };
  expect(describeUpdateCapsule(running, 1000 + 5_000)).toEqual({ tone: "default", label: "0 of 1 updated", action: null });
  expect(describeUpdateCapsule(running, 1000 + UPDATE_SLOW_AFTER_MS)).toEqual({ tone: "slow", label: "This Mac", slow: { status: "updating providers", elapsed: "3m" }, action: null });
  const failed = { machine: { ...base, providers: [{ ...base.providers[0]!, status: "failed" as const, failure: "boom" }] }, startedAt: 1000 };
  expect(describeUpdateCapsule(failed, 2000)).toEqual({ tone: "failed", label: "This Mac failed", action: "dismiss" });
  expect(runMachineFailure(failed.machine)).toBe("Codex: boom");
  expect(runFinishedCleanly(failed)).toBe(false);
  const done = { machine: { ...base, providers: [{ ...base.providers[0]!, status: "done" as const }] }, startedAt: 1000 };
  expect(describeUpdateCapsule(done, 2000).label).toBe("1 of 1 updated");
  expect(runFinishedCleanly(done)).toBe(true);
  expect(formatUpdateElapsed(30_000)).toBe("<1m");
  expect(formatUpdateElapsed(61 * 60_000)).toBe("1h 1m");
});

test("a run completes by itself when every provider updated", async () => {
  const machine = planMachine("This Mac", [provider("codex", "codex", "Codex")]);
  await startUpdateEverything(machine, async () => ({ status: "succeeded" }));
});
