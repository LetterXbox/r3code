import { expect, test } from "nsh/test";
import { buildPickerInstances, listFor, modelKeyOf, resolvePickerSelectedModel, startTab } from "./pickerModel";

const model = (slug: string, name: string, extra: Record<string, unknown> = {}) => ({ slug, name, isCustom: false, capabilities: null, ...extra });
const records = [
  {
    instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude", enabled: true, availability: "available", status: "ready",
    models: [
      model("opus-5.5", "Claude Opus 5.5"), model("sonnet-5.5", "Claude Sonnet 5.5"), model("fable-5.2", "Claude Fable 5.2"),
      model("haiku-5.5", "Claude Haiku 5.5"), model("opus-4.6", "Claude Opus 4.6", { isLegacy: true }), model("secret", "Hidden One"),
    ],
  },
  { instanceId: "claude_dev", driver: "claudeAgent", displayName: "Claude", enabled: true, availability: "available", status: "ready", models: [model("fable-5.2", "Claude Fable 5.2")] },
  { instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, availability: "unavailable", status: "error", models: [model("gpt-6", "GPT-6")] },
  { instanceId: "off", driver: "cursor", displayName: "Cursor", enabled: false, status: "ready", models: [model("x", "X")] },
];
const settings = { providerModelPreferences: { claudeAgent: { hiddenModels: ["secret"], modelOrder: ["fable-5.2", "opus-5.5"] } } };

test("only enabled instances are listed and an unready one has no models", () => {
  const instances = buildPickerInstances(records, settings);
  expect(instances.map((item) => item.instanceId)).toEqual(["claudeAgent", "claude_dev", "codex"]);
  expect(instances[2]!.ready).toBe(false);
  expect(instances[2]!.models).toEqual([]);
});

test("hidden models drop out and modelOrder leads, then the server's order", () => {
  const [claude] = buildPickerInstances(records, settings);
  expect(claude!.models.map((item) => item.slug)).toEqual(["fable-5.2", "opus-5.5", "sonnet-5.5", "haiku-5.5", "opus-4.6"]);
});

test("legacy models sit behind Show more, favourites lead, and Favorites keeps instance order", () => {
  const instances = buildPickerInstances(records, settings);
  const none = new Set<string>();
  const collapsed = listFor(instances, "claudeAgent", "", none, false);
  expect(collapsed.rows.map((item) => item.slug)).toEqual(["fable-5.2", "opus-5.5", "sonnet-5.5", "haiku-5.5"]);
  expect(collapsed.hiddenLegacy).toBe(1);
  expect(listFor(instances, "claudeAgent", "", none, true).rows.length).toBe(5);
  const starred = new Set(["claudeAgent:haiku-5.5", "claudeAgent:opus-4.6", "claude_dev:fable-5.2"]);
  const own = listFor(instances, "claudeAgent", "", starred, false);
  expect(own.rows.map((item) => item.slug)).toEqual(["haiku-5.5", "opus-4.6", "fable-5.2", "opus-5.5", "sonnet-5.5"]);
  expect(own.hiddenLegacy).toBe(0);
  expect(listFor(instances, "favorites", "", starred, false).rows.map(modelKeyOf)).toEqual(["claudeAgent:haiku-5.5", "claudeAgent:opus-4.6", "claude_dev:fable-5.2"]);
});

test("search spans providers and ignores legacy folding", () => {
  const instances = buildPickerInstances(records, settings);
  expect(listFor(instances, "claudeAgent", "fable", new Set(), false).rows.map(modelKeyOf)).toEqual(["claudeAgent:fable-5.2", "claude_dev:fable-5.2"]);
  expect(listFor(instances, "claudeAgent", "4.6", new Set(), false).rows.length).toBe(1);
});

test("instance badges: shared drivers and accents, named from the resolved display name", () => {
  const withAccent = [...records, { instanceId: "legion", driver: "codex", displayName: "Legion", accentColor: "#336699", enabled: true, status: "ready", models: [] }];
  const instances = buildPickerInstances(withAccent, settings);
  const byId = (id: string) => instances.find((item) => item.instanceId === id)!;
  expect(byId("claudeAgent").showBadge).toBe(true);
  expect(byId("claude_dev").displayName).toBe("Claude Dev");
  expect(byId("claude_dev").badge).toBe("CD");
  expect(byId("legion").badge).toBe("LE");
  expect(byId("legion").showBadge).toBe(true);
  expect(buildPickerInstances([records[0]!], settings)[0]!.showBadge).toBe(false);
});

test("the picker opens on Favorites when any exist, else the active instance", () => {
  const instances = buildPickerInstances(records, settings);
  expect(startTab(instances, "claudeAgent", new Set(["claudeAgent:opus-5.5"]))).toBe("favorites");
  expect(startTab(instances, "claude_dev", new Set())).toBe("claude_dev");
});

test("an OpenCode thread keeps its unlisted model as an unavailable last row", async () => {
  const { appendUnavailableSelection } = await import("./pickerModel");
  const listed = [{ instanceId: "oc", slug: "a", name: "A", isLegacy: false, isNew: false, isUnavailable: false, subProvider: null }];
  expect(appendUnavailableSelection(listed, "opencode", "oc", { instanceId: "oc", model: "gone" }, new Set()).map((model) => [model.slug, model.isUnavailable])).toEqual([["a", false], ["gone", true]]);
  expect(appendUnavailableSelection(listed, "codex", "oc", { instanceId: "oc", model: "gone" }, new Set()).length).toBe(1);
  expect(appendUnavailableSelection(listed, "opencode", "oc", { instanceId: "oc", model: "gone" }, new Set(["gone"])).length).toBe(1);
  expect(appendUnavailableSelection(listed, "antigravity", "oc", { instanceId: "oc", model: "antigravity-default" }, new Set()).length).toBe(1);
});

test("a started session keeps its provider unless it can hand off (getStartedThreadModelChangeBlockReason)", async () => {
  const { startedThreadModelChangeBlock } = await import("./pickerModel");
  const projection = { thread: { modelSelection: { instanceId: "codex" } }, providerSessions: [{ instanceId: "codex" }] };
  expect(startedThreadModelChangeBlock({ projection, nextInstanceId: "codex" })).toBe(null);
  expect(startedThreadModelChangeBlock({ projection, nextInstanceId: "claudeAgent" })?.title).toBe("Start a new chat to switch providers");
  expect(startedThreadModelChangeBlock({ projection: { ...projection, providerSessions: [] }, nextInstanceId: "claudeAgent" })).toBe(null);
});

test("the provider rail says why an instance is greyed out (describeUnavailableInstance)", async () => {
  const { describeUnavailableInstance } = await import("./pickerModel");
  const status = { enabled: true, available: true, status: "ready", message: null };
  expect(describeUnavailableInstance("Codex", status)).toBe("Codex");
  expect(describeUnavailableInstance("Codex", { ...status, enabled: false })).toBe("Codex: Disabled in settings.");
  expect(describeUnavailableInstance("Claude", { ...status, status: "error", available: false, message: " Not signed in. " })).toBe("Claude: Unavailable. Not signed in.");
  expect(describeUnavailableInstance("Claude", { ...status, status: "warning" })).toBe("Claude: Limited.");
  expect(describeUnavailableInstance("Claude", { ...status, status: "pending" })).toBe("Claude: Not ready.");
});

test("resolvePickerSelectedModel: Antigravity default alias resolves to its model; the alias is never a row", () => {
  const [ag] = buildPickerInstances([{ instanceId: "ag", driver: "antigravity", status: "ready", models: [
    { slug: "antigravity-default" }, { slug: "g-pro", isDefault: true }, { slug: "g-flash", aliases: ["antigravity-default"] },
  ] }], null);
  expect(ag.models.map((model) => model.slug)).toEqual(["g-pro", "g-flash"]);
  expect(resolvePickerSelectedModel("antigravity", "antigravity-default", ag.models)?.slug).toBe("g-flash");
  expect(resolvePickerSelectedModel("antigravity", "antigravity-default", ag.models.slice(0, 1))?.slug).toBe("g-pro");
  expect(resolvePickerSelectedModel("codex", "g-pro", ag.models)?.slug).toBe("g-pro");
});

test("a project's provider override hides or shows an instance in its picker (resolveProjectProviderInstanceEnabled)", async () => {
  const { buildPickerInstances } = await import("./pickerModel");
  const records = [
    { instanceId: "codex", driver: "codex", enabled: true, status: "ready", models: [{ slug: "m" }] },
    { instanceId: "claudeAgent", driver: "claudeAgent", enabled: false, status: "ready", models: [{ slug: "c" }] },
  ];
  const settings = { projectSettingsOverrides: { p1: { providerInstances: { codex: { enabled: false }, claudeAgent: { enabled: true } } } } };
  expect(buildPickerInstances(records, settings, null, null, "p1").map((i) => i.instanceId)).toEqual(["claudeAgent"]);
  expect(buildPickerInstances(records, settings, null, null, "p2").map((i) => i.instanceId)).toEqual(["codex"]);
});
