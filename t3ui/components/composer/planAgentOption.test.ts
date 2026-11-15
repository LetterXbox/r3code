import { expect, test } from "nsh/test";
import { parseDescriptors, selectsPlanAgent, withoutPlanAgentOption } from "./modelTraits";

const agent = parseDescriptors([{ id: "agent", label: "Agent", type: "select", currentValue: "plan", options: [{ id: "build", label: "Build", isDefault: true }, { id: "plan", label: "Plan" }] }]);

test("fm13: the composer drops the plan agent option and falls back to the default", () => {
  const [only] = withoutPlanAgentOption(agent);
  expect(only?.type === "select" ? only.options.map((o) => o.id) : []).toEqual(["build"]);
  expect(only?.type === "select" ? only.currentValue : null).toBe("build");
  expect(withoutPlanAgentOption(parseDescriptors([{ id: "agent", label: "Agent", type: "select", options: [{ id: "plan", label: "Plan" }] }]))).toEqual([]);
  expect(withoutPlanAgentOption(agent, true)).toEqual(agent);
  expect(selectsPlanAgent([{ id: "agent", value: "plan" }])).toBe(true);
  expect(selectsPlanAgent([{ id: "agent", value: "build" }])).toBe(false);
});
