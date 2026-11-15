import { expect, open, test } from "nsh/test";
import { clampManagedRuntimeMode, managedRuntimeModeDenial, managedSettingLock } from "./managedPolicyLocks";

const policy = { organization: "Acme", lockedSettings: ["storageCleanup.logsAfterDays", "defaultThreadEnvMode"], limits: { maxRuntimeMode: "auto-accept-edits" } };

test("a policy ceiling denies the modes above it and clamps a thread down", () => {
  expect(managedRuntimeModeDenial(policy, "auto")).toBe("Acme limits threads to Auto-accept edits.");
  expect(managedRuntimeModeDenial(policy, "full-access")).toBe("Acme limits threads to Auto-accept edits.");
  expect(managedRuntimeModeDenial(policy, "approval-required")).toBeUndefined();
  expect(managedRuntimeModeDenial(null, "full-access")).toBeUndefined();
  expect(clampManagedRuntimeMode(policy, "full-access")).toBe("auto-accept-edits");
  expect(clampManagedRuntimeMode(policy, "approval-required")).toBe("approval-required");
});

test("a locked setting is found by its path, inside it, or around it", () => {
  expect(managedSettingLock(policy, "defaultThreadEnvMode")).toBe("Acme");
  expect(managedSettingLock(policy, "storageCleanup.logsAfterDays")).toBe("Acme");
  expect(managedSettingLock(policy, "storageCleanup")).toBe("Acme");
  expect(managedSettingLock(policy, "defaultRuntimeMode")).toBeUndefined();
  expect(managedSettingLock(null, "defaultThreadEnvMode")).toBeUndefined();
});

test("Threads dims a locked control, says who manages it and offers only the permitted permissions", async () => {
  const app = await open("./ManagedFixture.tsx", { width: 1100, height: 2000 });
  await expect(app.shows("id:Control Workspace (managed)")).toBe(true);
  await expect(app.shows("id:Control Permissions (free)")).toBe(true);
  await app.press("label:Default permissions = full-access");
  await expect(app.texts()).toContain("Acme limits threads to Auto-accept edits.");
});
