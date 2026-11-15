import { expect, test } from "nsh/test";
import { describeEffort, ultrathinkPromptControlled, withPromptUltrathink, type Descriptor } from "./modelTraits";

const effort: Descriptor = {
  id: "effort", label: "Effort", type: "select", role: "reasoning", currentValue: "medium", promptInjectedValues: ["ultrathink"],
  options: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }, { id: "ultrathink", label: "Ultrathink" }],
} as Descriptor;

test("a typed ultrathink controls the effort while the prompt names it (TraitsPicker ultrathinkPromptControlled)", () => {
  expect(ultrathinkPromptControlled([effort], "please ultrathink about this")).toBe(true);
  expect(ultrathinkPromptControlled([effort], "please think about this")).toBe(false);
  expect(describeEffort(withPromptUltrathink([effort], "ULTRATHINK now"))?.word).toBe("Ultrathink");
  expect(describeEffort(withPromptUltrathink([effort], "plain"))?.word).toBe("Medium");
});
