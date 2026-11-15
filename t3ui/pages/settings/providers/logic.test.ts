import { expect, test } from "nsh/test";
import {
  buildNewInstance, buildRows, bulkHiddenModels, checkedLabel, deriveAvailableInstanceId, deriveInstanceId, groupModels, mergeLiveOnlyRows,
  modelsForDisplay, nextConfigWithField, nextEnvWithFieldValue, parseInstances, parseProvider, providerSummary, readCustomModels, resolveInstanceEnabled,
  resolveWizardNavigation, statusKey, stripTerminalEscapes, toCustomModelSetting, updateCandidates, updateRunSummary, validateCustomModel, validateInstanceId,
  versionAdvisoryPresentation, versionLabel,
} from "./logic";

const base = { instanceId: "codex", driver: "codex", enabled: true, installed: true, version: "1.0.0", status: "ready", auth: { status: "authenticated" }, models: [] };
const view = (over: Record<string, unknown> = {}) => parseProvider({ ...base, ...over }) as NonNullable<ReturnType<typeof parseProvider>>;

test("status text and colour follow providerStatus.ts", () => {
  expect(providerSummary(view()).headline).toBe("Authenticated");
  expect(providerSummary(view({ auth: { status: "authenticated", label: "Pro" } })).headline).toBe("Authenticated · Pro");
  expect(providerSummary(view({ auth: { status: "unauthenticated", type: "apiKey" }, message: "Run login" }))).toEqual({ headline: "Not authenticated · apiKey", detail: "Run login" });
  expect(providerSummary(view({ installed: false }))).toEqual({ headline: "Not found", detail: "CLI not detected on PATH." });
  expect(providerSummary(view({ enabled: false })).headline).toBe("Disabled");
  expect(providerSummary(view({ status: "warning" })).headline).toBe("Needs attention");
  expect(providerSummary(view({ status: "error", message: "boom" }))).toEqual({ headline: "Unavailable", detail: "boom" });
  expect(providerSummary(view({ auth: { status: "unknown" } })).headline).toBe("Available");
  expect(providerSummary(undefined).headline).toBe("Checking provider status");
  expect(statusKey(view({ enabled: false }))).toBe("disabled");
  expect(statusKey(view({ status: "error" }))).toBe("error");
  expect(statusKey(undefined)).toBe("warning");
});

test("antigravity reports an unchecked Google sign-in as neutral, not a warning", () => {
  const agy = view({ driver: "antigravity", instanceId: "antigravity", status: "warning", auth: { status: "unknown" } });
  expect(statusKey(agy)).toBe("neutral");
  expect(providerSummary(agy).headline).toBe("Installed · Sign-in not checked");
  expect(versionLabel("agy_acp_server_20260102_3_rc1")).toBe("2026-01-02 rc1");
  expect(versionLabel("1.2.3")).toBe("v1.2.3");
  expect(versionLabel("nightly")).toBe("nightly");
  expect(versionLabel(null)).toBeNull();
});

test("version advisories present updates and compatibility warnings", () => {
  const advisory = { status: "behind_latest", currentVersion: "1", latestVersion: "2.0.0", updateCommand: "npm i -g x", canUpdate: true, canInstallVersion: false, message: null };
  expect(versionAdvisoryPresentation(advisory, null)).toEqual({ title: "Update available", detail: "Update available: install v2.0.0.", updateCommand: "npm i -g x", emphasis: "normal", targetVersion: null });
  expect(versionAdvisoryPresentation({ ...advisory, status: "current" }, null)).toBeNull();
  const compat = { status: "broken", message: null, recommendedVersion: "1.9.0", recommendedRange: null };
  const shown = versionAdvisoryPresentation(advisory, compat);
  expect(shown?.title).toBe("Known broken version");
  expect(shown?.targetVersion).toBe("1.9.0");
  expect(shown?.emphasis).toBe("strong");
  expect(versionAdvisoryPresentation(advisory, compat, false)?.title).toBe("Update available");
});

test("the last-checked label is relative", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const at = (iso: string) => [view({ checkedAt: iso })];
  expect(checkedLabel(at("2026-11-11T11:59:50Z"), now)).toBe("Checked just now");
  expect(checkedLabel(at("2026-11-11T11:55:00Z"), now)).toBe("Checked 5m ago");
  expect(checkedLabel(at("2026-11-11T09:00:00Z"), now)).toBe("Checked 3h ago");
  expect(checkedLabel([view()], now)).toBeNull();
  expect(checkedLabel(at("not a date"), now)).toBe("Checked unavailable");
});

test("rows follow the registry order, default slots first, and cursor takes its registry slot only when the server reports it", () => {
  const live = [view(), view({ instanceId: "claudeAgent", driver: "claudeAgent" })];
  const instances = parseInstances({ pi: { driver: "pi" }, codex_work: { driver: "codex", displayName: "Work" }, opencode: { driver: "opencode", enabled: true }, cursor: { driver: "cursor", enabled: true } });
  const rows = buildRows(instances, live);
  expect(rows.map((row) => row.instanceId)).toEqual(["codex", "codex_work", "claudeAgent", "opencode", "pi", "cursor"]);
  expect(rows[0].isDefault).toBe(true);
  expect(rows[1].isDefault).toBe(false);
  expect(rows[rows.length - 1].isDefault).toBe(false);
  const withCursor = buildRows(instances, [...live, view({ instanceId: "cursor", driver: "cursor" })]);
  expect(withCursor.map((row) => row.instanceId)).toEqual(["codex", "codex_work", "claudeAgent", "cursor", "opencode", "pi"]);
  expect(mergeLiveOnlyRows(rows, [view({ instanceId: "extra", driver: "grok" })]).map((row) => row.instanceId)).toContain("extra");
});

test("an unconfigured default slot is on for Codex and Claude only", () => {
  expect(resolveInstanceEnabled({ driver: "codex" })).toBe(true);
  expect(resolveInstanceEnabled({ driver: "claudeAgent" })).toBe(true);
  expect(resolveInstanceEnabled({ driver: "grok" })).toBe(false);
  expect(resolveInstanceEnabled({ driver: "grok", enabled: true })).toBe(true);
  expect(resolveInstanceEnabled({ driver: "codex", config: { enabled: false } })).toBe(false);
  expect(resolveInstanceEnabled({ driver: "codex", enabled: true, config: { enabled: false } })).toBe(false);
});

test("config edits drop emptied fields that omit and keep the rest", () => {
  const omit = { key: "binaryPath", clearWhenEmpty: "omit" as const };
  const persist = { key: "binaryPath", clearWhenEmpty: "persist" as const };
  expect(nextConfigWithField({ homePath: "/h" }, omit, "/bin/x")).toEqual({ homePath: "/h", binaryPath: "/bin/x" });
  expect(nextConfigWithField({ binaryPath: "/bin/x" }, omit, "  ")).toBeUndefined();
  expect(nextConfigWithField({ binaryPath: "/bin/x", homePath: "/h" }, omit, "")).toEqual({ homePath: "/h" });
  expect(nextConfigWithField({ binaryPath: "/bin/x" }, persist, "")).toEqual({ binaryPath: "" });
});

test("dedicated environment fields write trimmed sensitive values and clear when emptied", () => {
  const field = { name: "CURSOR_API_KEY", label: "Cursor API key", sensitive: true };
  expect(nextEnvWithFieldValue(undefined, field, " key ")).toEqual([{ name: "CURSOR_API_KEY", value: "key", sensitive: true }]);
  expect(nextEnvWithFieldValue([{ name: "CURSOR_API_KEY", value: "old", sensitive: true }, { name: "FOO", value: "1", sensitive: false }], field, "")).toEqual([{ name: "FOO", value: "1", sensitive: false }]);
});

test("custom models round trip through the settings shape", () => {
  const entries = readCustomModels(["a", { slug: "b", name: "Bee" }, { slug: "a" }, 5, { slug: " " }]);
  expect(entries.map((entry) => entry.slug)).toEqual(["a", "b"]);
  expect(entries[1].name).toBe("Bee");
  expect(entries.map(toCustomModelSetting)).toEqual(["a", { slug: "b", name: "Bee" }]);
  const live = [{ slug: "x", name: "X", isCustom: false, isDefault: false, descriptors: [], hasCapabilities: false }];
  expect(modelsForDisplay(live, [{ slug: "x", name: "X", capabilities: null }, { slug: "mine", name: "Mine", capabilities: null }]).map((model) => [model.slug, model.isCustom])).toEqual([["x", false], ["mine", true]]);
  expect(validateCustomModel("", live, [])).toBe("Enter a model slug.");
  expect(validateCustomModel("x", live, [])).toBe("That model is already built in.");
  expect(validateCustomModel("mine", live, [{ slug: "mine", name: "mine", capabilities: null }])).toBe("That custom model is already saved.");
  expect(validateCustomModel("z".repeat(300), live, [])).toBe("Model slugs must be 256 characters or less.");
  expect(validateCustomModel("fresh", live, [])).toBeNull();
});

test("models group as favourites, visible, then hidden, each in saved order", () => {
  const models = ["a", "b", "c", "d"].map((slug) => ({ slug, isCustom: false }));
  const grouped = groupModels(models, { favorites: new Set(["d"]), hidden: new Set(["a"]), order: ["c", "b"] });
  expect(grouped.map((model) => model.slug)).toEqual(["d", "c", "b", "a"]);
  expect(bulkHiddenModels(models, [])).toEqual(["a", "b", "c", "d"]);
  expect(bulkHiddenModels(models, ["a", "b", "c", "d", "mine"])).toEqual(["mine"]);
});

test("instance ids derive from the label and stay unique", () => {
  expect(deriveInstanceId("codex", "Work Account!")).toBe("codex_work_account");
  expect(deriveInstanceId("codex", "   ")).toBe("");
  expect(deriveAvailableInstanceId((label) => deriveInstanceId("codex", label), "Work", new Set(["codex_work", "codex_work_2"]))).toBe("codex_work_3");
  expect(validateInstanceId("", new Set())).toBe("Instance ID is required.");
  expect(validateInstanceId("9x", new Set())).toBe("Instance ID must start with a letter and use only letters, digits, '-', or '_'.");
  expect(validateInstanceId("codex", new Set(["codex"]))).toBe("An instance named 'codex' already exists.");
  expect(validateInstanceId("ok_id-2", new Set())).toBeNull();
});

test("the wizard blocks leaving identity with an invalid id and builds the instance it saves", () => {
  expect(resolveWizardNavigation(1, 2, 3, { instanceIdError: "bad" })).toEqual({ kind: "blocked", step: 1, error: "bad" });
  expect(resolveWizardNavigation(0, 2, 3, { instanceIdError: "bad" })).toEqual({ kind: "blocked", step: 1, error: "bad" });
  expect(resolveWizardNavigation(2, 1, 3, { instanceIdError: "bad" })).toEqual({ kind: "navigate", step: 1 });
  expect(resolveWizardNavigation(0, 1, 3, { instanceIdError: "bad" })).toEqual({ kind: "navigate", step: 1 });
  expect(buildNewInstance({ driver: "codex", label: " Work ", accentColor: "#ABC", config: {} })).toEqual({ driver: "codex", enabled: true, displayName: "Work", accentColor: "#abc", config: { setupMode: "existing" } });
  expect(buildNewInstance({ driver: "grok", label: "", accentColor: "red", config: {} })).toEqual({ driver: "grok", enabled: true });
});

test("the sign-in terminal shows plain text", () => {
  expect(stripTerminalEscapes("\u001b[32mHello\u001b[0m\r\nWorld")).toBe("Hello\nWorld");
  expect(stripTerminalEscapes("10%\r50%\r100%\nDone")).toBe("100%\nDone");
  expect(stripTerminalEscapes("\u001b]0;title\u0007Prompt> ")).toBe("Prompt> ");
});

test("update-all lists one enabled provider per driver that can update in place", () => {
  const behind = (over: Record<string, unknown>) => view({ versionAdvisory: { status: "behind_latest", latestVersion: "2", canUpdate: true, updateCommand: "x", currentVersion: "1", checkedAt: null, message: null }, ...over });
  const found = updateCandidates([behind({ instanceId: "codex_work" }), behind({}), behind({ instanceId: "g", driver: "grok", enabled: false }), view({ instanceId: "c2", driver: "claudeAgent" })]);
  expect(found.map((provider) => provider.instanceId)).toEqual(["codex"]);
});

test("update-all skips candidates the compatibility check rules out and drivers whose instances disagree on the command", () => {
  const behind = (over: Record<string, unknown>, command: string | null = "npm i") => view({ versionAdvisory: { status: "behind_latest", latestVersion: "2", canUpdate: command !== null, updateCommand: command, currentVersion: "1", checkedAt: null, message: null, canInstallVersion: false }, ...over });
  expect(updateCandidates([behind({ compatibilityAdvisory: { status: "supported", latestVersionStatus: "broken", message: null, recommendedVersion: null, recommendedRange: null } })]).length).toBe(0);
  expect(updateCandidates([behind({ updateState: { status: "running", message: null, output: null } })]).length).toBe(0);
  expect(updateCandidates([behind({}, null)]).length).toBe(0);
  expect(updateCandidates([behind({ instanceId: "a" }, "npm i a"), behind({ instanceId: "b" }, "npm i b")]).length).toBe(0);
  expect(updateCandidates([behind({ instanceId: "a" }), behind({ instanceId: "b" })]).length).toBe(1);
});

test("the update run summary reports success, partial failure and total failure like the web toast", () => {
  const run = (driver: string, failure: string | null | "interrupted") => ({ machineLabel: "Mac", driver, instanceId: driver, outcome: failure === "interrupted" ? { kind: "interrupted" as const } : { kind: "result" as const, failure } });
  const name = (driver: string) => driver.toUpperCase();
  expect(updateRunSummary([run("a", "interrupted")], name)).toBeNull();
  expect(updateRunSummary([run("a", null)], name)).toEqual({ type: "success", title: "Provider updated", description: "New sessions will use the updated provider." });
  expect(updateRunSummary([run("a", null), run("b", null)], name)?.title).toBe("2 providers updated");
  expect(updateRunSummary([run("a", null), run("b", "boom")], name)).toEqual({ type: "error", title: "1 of 2 provider updates failed", description: "Mac · B: boom" });
  expect(updateRunSummary([run("a", "x")], name)?.title).toBe("Provider update failed");
  expect(updateRunSummary([run("a", "x"), run("b", "y")], name)?.title).toBe("Provider updates failed");
});
