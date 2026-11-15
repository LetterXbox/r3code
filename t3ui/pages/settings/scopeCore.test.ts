import { expect, test } from "nsh/test";
import { inheritanceLayers, inheritanceSummary, listProjectOverrides, planClear, planPatch, resolveEffective, resolveScope, selectEnvironmentAxis, selectProjectAxis, settingSource } from "./scopeCore";

const env = { environmentId: "environment:local", label: "This machine", connected: true };
const projects = [{ id: "project:1", name: "legion", path: "/work/legion" }, { id: "project:2", name: "other" }];
const base = {
  defaultRuntimeMode: "full-access",
  defaultThreadEnvMode: null,
  defaultModelSelection: null,
  worktreeSubmodules: null,
  defaultAutoPull: false,
  projectSettingsOverrides: { "project:1": { defaultAutoPull: true, defaultModelSelection: { instanceId: "codex", model: "gpt" } } },
};

test("a scope resolves to all, the environment, a project, or an unavailable selection that never broadens", () => {
  expect(resolveScope({}, projects, [env]).kind).toBe("all");
  expect(resolveScope({ machine: env.environmentId }, projects, [env])).toMatchObject({ kind: "environment", label: "This machine" });
  expect(resolveScope({ project: "project:1" }, projects, [env])).toMatchObject({ kind: "project", label: "legion / All checkouts" });
  expect(resolveScope({ project: "project:1", machine: env.environmentId }, projects, [env]).label).toBe("legion / This machine");
  expect(resolveScope({ project: "gone" }, projects, [env])).toMatchObject({ kind: "unavailable", message: "This project is no longer available." });
  expect(resolveScope({ machine: "gone" }, projects, [env])).toMatchObject({ kind: "unavailable", message: "This environment is no longer available." });
});

test("a project's effective settings lay its overrides over the environment and name the source", () => {
  const resolved = resolveEffective(base, "project:1");
  expect(resolved.settings.defaultAutoPull).toBe(true);
  expect(resolved.sources.defaultAutoPull).toBe("project");
  expect(resolved.sources.defaultRuntimeMode).toBe("environment");
  expect(resolved.settings.defaultThreadEnvMode).toBe("local");
  expect(resolveEffective(base, "project:2").settings.defaultAutoPull).toBe(false);
  expect(settingSource(resolveScope({ project: "project:1" }, projects, [env]), base, ["defaultAutoPull"])).toBe("project");
  expect(settingSource(resolveScope({}, projects, [env]), base, ["defaultAutoPull"])).toBe("environment");
});

test("an environment write sends the patch; a project write becomes an override entry", () => {
  const all = resolveScope({}, projects, [env]);
  expect(planPatch(all, base, { defaultRuntimeMode: "auto" }, true)).toEqual({ patch: { defaultRuntimeMode: "auto" }, unavailableReason: null });
  const project = resolveScope({ project: "project:2" }, projects, [env]);
  expect(planPatch(project, base, { defaultRuntimeMode: "auto" }, true).patch).toEqual({ projectSettingsOverrides: { "project:2": { defaultRuntimeMode: "auto" } } });
  // Existing overrides are kept.
  const one = resolveScope({ project: "project:1" }, projects, [env]);
  expect(planPatch(one, base, { defaultRuntimeMode: "auto" }, true).patch).toEqual({ projectSettingsOverrides: { "project:1": { ...base.projectSettingsOverrides["project:1"], defaultRuntimeMode: "auto" } } });
});

test("inherit removes an override unless null is the value, and an environment-wide key refuses a project", () => {
  const one = resolveScope({ project: "project:1" }, projects, [env]);
  expect(planPatch(one, base, { defaultAutoPull: null }, true).patch).toEqual({ projectSettingsOverrides: { "project:1": { defaultModelSelection: base.projectSettingsOverrides["project:1"].defaultModelSelection } } });
  expect(planPatch(one, base, { defaultModelSelection: null }, true).patch).toEqual({ projectSettingsOverrides: { "project:1": { defaultAutoPull: true, defaultModelSelection: null } } });
  expect(planPatch(one, base, { addProjectBaseDirectory: "~/x" }, true)).toEqual({ patch: null, unavailableReason: "This setting is environment-wide and cannot be overridden by a project." });
  expect(planPatch(one, base, { defaultAutoPull: true }, false).unavailableReason).toBe("Connect the selected checkouts, or update their environments, to save a project override.");
  expect(planPatch(resolveScope({ machine: env.environmentId }, projects, [env]), base, { a: 1 }, false).unavailableReason).toBe("Connect This machine to save this setting.");
});

test("a new model keeps no options from the previous one, and clearing the last override deletes the entry", () => {
  const withOptions = { ...base, projectSettingsOverrides: { "project:1": { defaultModelSelection: { instanceId: "codex", model: "gpt", options: [{ id: "effort", value: "high" }] } } } };
  const one = resolveScope({ project: "project:1" }, projects, [env]);
  const next = planPatch(one, withOptions, { defaultModelSelection: { instanceId: "claudeAgent", model: "opus" } }, true).patch as any;
  expect(next.projectSettingsOverrides["project:1"].defaultModelSelection).toEqual({ instanceId: "claudeAgent", model: "opus" });
  const only = { ...base, projectSettingsOverrides: { "project:1": { defaultAutoPull: true } } };
  expect(planClear(one, only, ["defaultAutoPull"]).patch).toEqual({ projectSettingsOverrides: { "project:1": null } });
  expect(planClear(one, base, ["defaultAutoPull"]).patch).toEqual({ projectSettingsOverrides: { "project:1": { defaultModelSelection: base.projectSettingsOverrides["project:1"].defaultModelSelection } } });
});

test("project overrides are listed per key and the inheritance chain names the winning layer", () => {
  expect(listProjectOverrides(base, ["defaultAutoPull"])).toEqual(["project:1"]);
  expect(listProjectOverrides(base, ["addProjectBaseDirectory"])).toEqual([]);
  const one = resolveScope({ project: "project:1" }, projects, [env]);
  const layers = inheritanceLayers(one, base, "This machine", "defaultAutoPull", false);
  expect(layers.map((layer) => [layer.key, layer.value, layer.effective])).toEqual([["project", "On", true], ["environment", "Inherits", false], ["built-in", "Off", false]]);
  const other = inheritanceLayers(resolveScope({ project: "project:2" }, projects, [env]), base, "This machine", "defaultAutoPull", false);
  expect(other.find((layer) => layer.effective)?.key).toBe("built-in");
  expect(inheritanceSummary("project", true, false, "This machine")).toEqual({ state: "overridden", summary: "Overridden for this project" });
  expect(inheritanceSummary("environment", true, false, "This machine").summary).toBe("Inherited from This machine");
  expect(inheritanceSummary("environment", false, false, "x").summary).toBe("Built-in default");
});

test("choosing one axis keeps the other", () => {
  expect(selectProjectAxis({ machine: "m" }, "p")).toEqual({ project: "p", machine: "m" });
  expect(selectProjectAxis({ project: "p", machine: "m" }, "all")).toEqual({ machine: "m" });
  expect(selectEnvironmentAxis({ project: "p" }, "m")).toEqual({ project: "p", machine: "m" });
  expect(selectEnvironmentAxis({ project: "p", machine: "m" }, "all")).toEqual({ project: "p" });
});

import { parseT3File } from "./scopeCore";
import { loadProjectFile, projectFileInvalid, projectFileOf } from "./scopeState";

test("t3.json is lenient JSON; the file tier fills a null environment value, below a project override", () => {
  const file = parseT3File('{ // note\n "defaultThreadEnvMode": "worktree", "worktreeSubmodules": "none", "scripts": [], }');
  expect(file).toEqual({ defaultThreadEnvMode: "worktree", worktreeSubmodules: "none", scripts: [] });
  expect(parseT3File("not json")).toBe(null);
  const resolved = resolveEffective(base, "project:2", { file });
  expect(resolved.settings.defaultThreadEnvMode).toBe("worktree");
  expect(resolved.sources.defaultThreadEnvMode).toBe("t3.json");
  expect(resolveEffective({ ...base, defaultThreadEnvMode: "local" }, "project:2", { file }).sources.defaultThreadEnvMode).toBe("environment");
  expect(settingSource(resolveScope({ project: "project:2" }, projects, [env]), base, ["defaultThreadEnvMode"], { file })).toBe("t3.json");
  const layers = inheritanceLayers(resolveScope({ project: "project:2" }, projects, [env]), base, "This machine", "defaultThreadEnvMode", null, { file });
  expect(layers.map((layer) => layer.key)).toEqual(["project", "environment", "t3.json", "built-in"]);
  expect(layers.find((layer) => layer.effective)?.value).toBe("New worktree");
});

test("the legacy project fields apply until the server folds them, and a folded server ignores them", () => {
  const legacy = { defaultThreadEnvMode: "worktree", defaultModelSelection: { instanceId: "codex", model: "gpt" } };
  expect(resolveEffective(base, "project:2", { legacy }).settings.defaultThreadEnvMode).toBe("worktree");
  expect(resolveEffective(base, "project:2", { legacy }).sources.defaultModelSelection).toBe("project");
  expect(resolveEffective({ ...base, projectSettingsFolded: true }, "project:2", { legacy }).sources.defaultModelSelection).toBe("environment");
  expect(resolveEffective({ ...base, projectAutoPullOverrides: { "project:2": true } }, "project:2", { legacy }).settings.defaultAutoPull).toBe(true);
});

test("a project's t3.json is read once through projects.readFile and an invalid one is flagged", async () => {
  const calls: unknown[] = [];
  await loadProjectFile({ id: "p", name: "p", path: "/w/p" }, async (method, payload) => { calls.push([method, payload]); return { exists: true, truncated: false, contents: '{"defaultThreadEnvMode":"worktree"}' }; });
  expect(calls).toEqual([["projects.readFile", { cwd: "/w/p", relativePath: "t3.json", allowMissing: true }]]);
  expect(projectFileOf("p")).toEqual({ defaultThreadEnvMode: "worktree" });
  await loadProjectFile({ id: "q", name: "q", path: "/w/q" }, async () => ({ exists: true, truncated: false, contents: "{oops" }));
  expect(projectFileOf("q")).toBe(null);
  expect(projectFileInvalid("q")).toBe(true);
  await loadProjectFile({ id: "r", name: "r", path: "/w/r" }, async () => ({ exists: false, truncated: false, contents: "" }));
  expect(projectFileOf("r")).toBe(null);
  expect(projectFileInvalid("r")).toBe(false);
});
