import { expect, test } from "nsh/test";
import { compareVersions, formatUpdateRequiredNotice, providerSetupEntries, setupActionLabel, updateRequiredNotices } from "./modelPickerNotices";
import type { PickerInstance } from "./pickerModel";
import type { ProviderStatus } from "../../store";

const status = (patch: Partial<ProviderStatus>): ProviderStatus => ({ instanceId: "codex", driver: "codex", name: "Codex", enabled: true, installed: true, available: true, status: "ready", authStatus: "authenticated", authLabel: null, version: "1.0.0", unavailableReason: null, message: null, checkedAt: null, canInstall: false, canAuthenticate: true, models: [], ...patch });
const instance = (patch: Partial<PickerInstance>): PickerInstance => ({ instanceId: "codex", driver: "codex", displayName: "Codex", accentColor: null, ready: true, showBadge: false, badge: "C", models: [{ instanceId: "codex", slug: "gpt-5", name: "GPT-5", isLegacy: false, isNew: false, isUnavailable: false, subProvider: null }], ...patch });

test("setup is offered for a provider that is signed out, not installed or not ready, and not for a healthy one", () => {
  const base = { selectedInstanceId: "codex", searching: false, listEmpty: false };
  expect(providerSetupEntries({ ...base, instances: [instance({})], statuses: [status({})] })).toEqual([]);
  expect(providerSetupEntries({ ...base, instances: [instance({})], statuses: [status({ authStatus: "unauthenticated" })] })).toHaveLength(1);
  expect(providerSetupEntries({ ...base, instances: [instance({})], statuses: [status({ installed: false, canInstall: true, canAuthenticate: false })] })).toHaveLength(1);
  expect(providerSetupEntries({ ...base, instances: [instance({ ready: false })], statuses: [status({})] })).toHaveLength(1);
  expect(providerSetupEntries({ ...base, instances: [instance({})], statuses: [status({ enabled: false })] })).toEqual([]);
  expect(providerSetupEntries({ ...base, instances: [instance({})], statuses: [status({ canAuthenticate: false, canInstall: false, authStatus: "unauthenticated" })] })).toEqual([]);
});

test("setup shows for the chosen provider, for every provider on an empty Favorites list, and never while searching", () => {
  const instances = [instance({}), instance({ instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude", ready: false })];
  const statuses = [status({ authStatus: "unauthenticated" }), status({ instanceId: "claudeAgent", driver: "claudeAgent", name: "Claude", status: "error" })];
  expect(providerSetupEntries({ instances, statuses, selectedInstanceId: "claudeAgent", searching: false, listEmpty: false }).map((entry) => entry.instance.instanceId)).toEqual(["claudeAgent"]);
  expect(providerSetupEntries({ instances, statuses, selectedInstanceId: "favorites", searching: false, listEmpty: true })).toHaveLength(2);
  expect(providerSetupEntries({ instances, statuses, selectedInstanceId: "favorites", searching: false, listEmpty: false })).toEqual([]);
  expect(providerSetupEntries({ instances, statuses, selectedInstanceId: "claudeAgent", searching: true, listEmpty: true })).toEqual([]);
  expect(setupActionLabel(1, "Claude")).toBe("Open provider setup");
  expect(setupActionLabel(2, "Claude")).toBe("Set up Claude");
});

test("the update-required notice names the runtime, the highest version needed and the models", () => {
  const provider = { driver: "claudeAgent", updateRequiredModels: [{ slug: "opus-5", name: "Opus 5", minVersion: "2.1.0" }, { slug: "fable-5", name: "Fable 5", minVersion: "v2.3.1" }, { slug: "sonnet-5", name: "Sonnet 5", minVersion: "2.2.0" }] };
  expect(formatUpdateRequiredNotice(provider)).toBe("Update Claude Code to v2.3.1 or newer to use Opus 5, Fable 5, and Sonnet 5.");
  expect(formatUpdateRequiredNotice(provider, "fable")).toBe("Update Claude Code to v2.3.1 or newer to use Fable 5.");
  expect(formatUpdateRequiredNotice(provider, "nothing")).toBeNull();
  expect(formatUpdateRequiredNotice({ driver: "codex", updateRequiredModels: [{ slug: "g", name: "GPT-6", minVersion: "0.9.0" }, { slug: "h", name: "GPT-6 Mini", minVersion: "0.9.0" }] })).toBe("Update the Codex CLI to v0.9.0 or newer to use GPT-6 and GPT-6 Mini.");
  expect(compareVersions("1.2.0", "1.10.0")).toBeLessThan(0);
  expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
});

test("update-required notices come from the raw snapshots: the chosen provider's, or every matching one while searching", () => {
  const instances = [instance({}), instance({ instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude" })];
  const records = [{ instanceId: "codex", updateRequiredModels: [{ slug: "g", name: "GPT-6", minVersion: "0.9.0" }] }, { instanceId: "claudeAgent", updateRequiredModels: [{ slug: "o", name: "Opus 5", minVersion: "2.1.0" }] }];
  expect(updateRequiredNotices({ instances, records, selectedInstanceId: "codex", searching: false, query: "" }).map((entry) => entry.instanceId)).toEqual(["codex"]);
  expect(updateRequiredNotices({ instances, records, selectedInstanceId: "favorites", searching: false, query: "" })).toEqual([]);
  expect(updateRequiredNotices({ instances, records, selectedInstanceId: "favorites", searching: true, query: "opus" }).map((entry) => entry.instanceId)).toEqual(["claudeAgent"]);
});
