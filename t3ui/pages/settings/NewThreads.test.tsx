import { expect, open, test } from "nsh/test";

test("Threads lists the New threads card with the web's copy and the server's defaults", async () => {
  const app = await open("./NewThreadsFixture.tsx", { width: 1100, height: 2000 });
  for (const text of ["New threads", "Model", "Default model for new threads. Projects can override it.", "Fallback model", "Used for new threads when the default model's provider is out of usage.", "Permissions", "Default permissions for new threads. Projects can override them.", "Workspace", "Where new threads start. Projects and their t3.json can override it."]) {
    await expect(app.texts()).toContain(text);
  }
  await expect(app.shows("label:Default permissions = full-access")).toBe(true);
  await expect(app.shows("label:Default workspace = local")).toBe(true);
  await expect(app.shows("label:Fallback model")).toBe(true);
});

test("changing the default permissions writes the server setting, and a project overrides it for itself", async () => {
  const app = await open("./NewThreadsFixture.tsx", { width: 1100, height: 2000 });
  await app.press("label:Default permissions = full-access");
  await app.press("label:Auto-accept edits");
  await app.wait(80);
  await expect(app.texts()).toContain(`call server.updateSettings {"patch":{"defaultRuntimeMode":"auto-accept-edits"}}`);
  await app.press("label:Project scope: All projects");
  await app.press("label:legion");
  await expect(app.texts()).toContain("Permissions for new threads in this project.");
  await expect(app.texts()).toContain("Model for new threads in this project.");
  await expect(app.shows("label:Default permissions = approval-required")).toBe(true);
  await expect(app.shows("label:Fallback model")).toBe(false);
  await app.press("label:Default workspace = local");
  await app.press("label:New worktree");
  await app.wait(80);
  await expect(app.texts()).toContain(`call server.updateSettings {"patch":{"projectSettingsOverrides":{"project:1":{"defaultRuntimeMode":"approval-required","defaultThreadEnvMode":"worktree"}}}}`);
});

import { readSelectionWithOptions, traitsFor, withOption } from "./ModelTraitsControl";

test("a model's options come from its descriptors and a change keeps the others", () => {
  const models = [{ provider: "codex", model: "m", optionDescriptors: [{ id: "reasoningEffort", label: "Effort", type: "select", options: [{ id: "low", label: "Low" }, { id: "high", label: "High", isDefault: true }] }, { id: "fast", label: "Fast", type: "boolean" }] }];
  const selection = readSelectionWithOptions({ instanceId: "codex", model: "m", options: [{ id: "fast", value: true }] });
  const traits = traitsFor(selection, models);
  expect(traits.map((trait) => trait.id)).toEqual(["reasoningEffort", "fast"]);
  expect(withOption(selection!, traits, "reasoningEffort", "low")).toEqual({ instanceId: "codex", model: "m", options: [{ id: "reasoningEffort", value: "low" }, { id: "fast", value: true }] });
  expect(traitsFor(null, models)).toEqual([]);
  expect(readSelectionWithOptions({ instanceId: 1 })).toBe(null);
});

test("the default model shows its effort and writes the model again with the chosen option", async () => {
  const app = await open("./NewThreadsFixture.tsx", { width: 1100, height: 2000 });
  await app.press("label:Default model traits: High");
  await app.press("label:Default model Effort Low");
  await app.wait(80);
  await expect(app.texts()).toContain(`call server.updateSettings {"patch":{"defaultModelSelection":{"instanceId":"codex","model":"gpt-6-sol","options":[{"id":"reasoningEffort","value":"low"}]}}}`);
});

test("the automatic default model is the first driver group's default model, as resolveProjectDefaultProviderModelSelection picks it", async () => {
  const { resolveAutomaticModel } = await import("./NewThreadsControls");
  const records = [
    { instanceId: "codex_work", driver: "codex", enabled: true, status: "ready", models: [{ slug: "a" }] },
    { instanceId: "claudeAgent", driver: "claudeAgent", enabled: true, status: "ready", models: [{ slug: "c" }] },
    { instanceId: "codex", driver: "codex", enabled: true, status: "ready", models: [{ slug: "gpt-6.1-sol", isCustom: true }, { slug: "gpt-6-sol" }, { slug: "gpt-6-astra", isDefault: true }] },
  ];
  expect(resolveAutomaticModel(records)).toEqual({ instanceId: "codex", model: "gpt-6-astra" });
  expect(resolveAutomaticModel([{ ...records[2], status: "error" }, records[1]])).toEqual({ instanceId: "claudeAgent", model: "c" });
  // applyProviderInstanceSettings: a project that turns codex off gets the next driver; other projects keep codex.
  const settings = { projectSettingsOverrides: { "project:1": { providerInstances: { codex: { enabled: false }, codex_work: { enabled: false } } } } };
  expect(resolveAutomaticModel(records, settings, "project:1")).toEqual({ instanceId: "claudeAgent", model: "c" });
  expect(resolveAutomaticModel(records, settings, "project:2")).toEqual({ instanceId: "codex", model: "gpt-6-astra" });
  expect(resolveAutomaticModel(records, settings, null)).toEqual({ instanceId: "codex", model: "gpt-6-astra" });
});
