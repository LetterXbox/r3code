import { expect, test } from "nsh/test";
import { autoBalanceUpdateSummary, updateMachineDetail, type UpdateMachine } from "./autoBalanceUpdates";

const m = (key: string, over: Partial<UpdateMachine> = {}): UpdateMachine => ({ key, label: key, connected: true, remoteUpdate: true, targetVersion: "1.2.0", state: { status: "idle" }, dismissKey: null, ...over });

test("auto-balance update notice copy across machines", () => {
  expect(autoBalanceUpdateSummary([])).toBe(null);
  const idle = autoBalanceUpdateSummary([m("a"), m("b")]);
  expect([idle?.title, idle?.actionLabel, idle?.description]).toEqual(["Update available for 2 machines", "Update all", undefined]);
  const partial = autoBalanceUpdateSummary([m("a"), m("b", { remoteUpdate: false }), m("c", { connected: false })]);
  expect([partial?.title, partial?.actionLabel, partial?.description]).toEqual(["Update available for 3 machines", "Update 1 machine", "1 needs a manual update"]);
  const failed = autoBalanceUpdateSummary([m("a", { state: { status: "failed", stage: "downloading", fromVersion: "1", targetVersion: "1.2.0", message: "boom" } }), m("b")]);
  expect([failed?.title, failed?.status, failed?.actionLabel]).toEqual(["Could not update 1 machine", "failed", "Retry"]);
  const running = autoBalanceUpdateSummary([m("a", { state: { status: "running", stage: "downloading", fromVersion: "1", targetVersion: "1.2.0" } }), m("b")]);
  expect([running?.title, running?.actionLabel]).toEqual(["Updating 1 machine", null]);
  expect(updateMachineDetail(m("a", { remoteUpdate: false }))).toBe("Manual update required");
  expect(updateMachineDetail(m("a"))).toBe("Ready to update to 1.2.0");
  expect(updateMachineDetail(m("a", { connected: false }))).toBe("Reconnect this machine to update");
});

test("version-mismatch dismissals are kept per environment and version pair", async () => {
  const { dismissVersionMismatch, isVersionMismatchDismissed, versionMismatchDismissalKey } = await import("./autoBalanceUpdates");
  const key = versionMismatchDismissalKey("env-b", { clientVersion: "1.2.0", serverVersion: "1.1.0" });
  expect(key).toBe("env-b:1.2.0:1.1.0");
  expect(isVersionMismatchDismissed(key)).toBe(false);
  dismissVersionMismatch(key);
  expect(isVersionMismatchDismissed(key)).toBe(true);
  expect(isVersionMismatchDismissed("env-b:1.3.0:1.1.0")).toBe(false);
});
