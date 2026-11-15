import { expect, test } from "nsh/test";
import {
  buildTraitsDisplay, columnControls, descriptorsWithSelections, describeEffort, effortBarHeights, parseDescriptors,
  resolveEffortGlyph, selectionsFromDescriptors, splitSpeed, stepReasoning, traitsView,
} from "./modelTraits";

const raw = [
  { id: "effort", label: "Effort", type: "select", options: [
    { id: "low", label: "Low" }, { id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }, { id: "max", label: "Max" },
    { id: "ultrathink", label: "Ultrathink" },
  ], promptInjectedValues: ["ultrathink"] },
  { id: "fastMode", label: "Fast mode", type: "boolean" },
  { id: "contextWindow", label: "Context window", type: "select", options: [{ id: "200k", label: "200k", isDefault: true }, { id: "1m", label: "1M" }] },
  { bogus: true },
];

test("parseDescriptors keeps well-formed select and boolean descriptors", () => {
  const parsed = parseDescriptors(raw);
  expect(parsed.map((item) => item.id)).toEqual(["effort", "fastMode", "contextWindow"]);
  expect(parseDescriptors("nope")).toEqual([]);
});

test("picked values become current values and a send carries the resolved selections", () => {
  const picked = descriptorsWithSelections(parseDescriptors(raw), [{ id: "effort", value: "high" }, { id: "fastMode", value: true }]);
  expect(selectionsFromDescriptors(picked)).toEqual([
    { id: "effort", value: "high" }, { id: "fastMode", value: true }, { id: "contextWindow", value: "200k" },
  ]);
});

test("the trigger detail joins traits and folds Fast into the reasoning label", () => {
  const picked = descriptorsWithSelections(parseDescriptors(raw), [{ id: "effort", value: "high" }, { id: "fastMode", value: true }]);
  expect(buildTraitsDisplay(picked)).toEqual({ label: "High Fast · 200k", speedLabel: "Fast", ultracode: false });
});

test("the effort glyph fills up to the level, and max is named instead of drawn", () => {
  const view = traitsView(parseDescriptors(raw));
  const effort = view.selects[0]!;
  expect(resolveEffortGlyph(effort, "medium")).toMatchObject({ count: 3, filled: 2, special: null });
  expect(resolveEffortGlyph(effort, "max")).toMatchObject({ count: 3, filled: 3, special: "Max" });
  expect(effortBarHeights(3, 12)).toEqual([6, 9, 12].map((n) => n));
});

test("the column leads with the reasoning control and keeps speed out of it", () => {
  const view = traitsView(parseDescriptors(raw));
  const { effort, others } = columnControls(view);
  expect(effort?.descriptor.id).toBe("effort");
  expect(others.map((item) => item.descriptor.id)).toEqual(["contextWindow"]);
  expect(splitSpeed(view).fastToggle?.id).toBe("fastMode");
});

test("describeEffort gives the bars, the context window and the detail for the trigger", () => {
  const suffix = describeEffort(descriptorsWithSelections(parseDescriptors(raw), [{ id: "effort", value: "low" }]));
  expect(suffix?.glyph).toEqual({ count: 3, filled: 1 });
  expect(suffix?.contextWindow).toBe("200k");
  expect(suffix?.detail).toBe("Low · 200k");
  expect(describeEffort([])).toBe(null);
});

test("stepReasoning walks the pickable levels and skips prompt-injected ones", () => {
  const descriptors = descriptorsWithSelections(parseDescriptors(raw), [{ id: "effort", value: "max" }]);
  expect(stepReasoning(descriptors, 1)).toEqual({ id: "effort", value: "low" });
  expect(stepReasoning(descriptors, -1)).toEqual({ id: "effort", value: "high" });
});

test("saved options of an OpenCode model the catalog dropped show as read-only rows, without the plan agent (TraitsPicker)", async () => {
  const { unavailableModelOptionDescriptors } = await import("./modelTraits");
  expect(unavailableModelOptionDescriptors([{ id: "variant", value: "high" }, { id: "fastMode", value: true }, { id: "agent", value: "plan" }, { id: "contextWindow", value: "1m" }])).toEqual([
    { id: "variant", label: "Reasoning", type: "select", options: [{ id: "high", label: "high" }], currentValue: "high" },
    { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue: true },
    { id: "contextWindow", label: "Context Window", type: "select", options: [{ id: "1m", label: "1m" }], currentValue: "1m" },
  ]);
  expect(unavailableModelOptionDescriptors([{ id: "agent", value: "plan" }], true).map((entry) => entry.id)).toEqual(["agent"]);
  expect(unavailableModelOptionDescriptors(undefined)).toEqual([]);
});

test("speedIconFor reads Fast mode and the service tier through the selection (getTraitsSpeedDisplay)", async () => {
  const { speedIconFor } = await import("./modelTraits");
  const fast = parseDescriptors([{ id: "fastMode", label: "Fast mode", type: "boolean" }]);
  expect(speedIconFor(fast, [{ id: "fastMode", value: true }])).toBe("fast");
  expect(speedIconFor(fast, [{ id: "fastMode", value: false }])).toBe(null);
  const tier = parseDescriptors([{ id: "serviceTier", label: "Speed", type: "select", options: [{ id: "default", label: "Standard", isDefault: true }, { id: "fast", label: "Fast" }, { id: "ultra", label: "Ultrafast" }] }]);
  expect(speedIconFor(tier, [{ id: "serviceTier", value: "ultra" }])).toBe("ultrafast");
  expect(speedIconFor(tier, [{ id: "serviceTier", value: "fast" }])).toBe("fast");
  expect(speedIconFor(tier, undefined)).toBe(null);
});
