import { expect, test } from "nsh/test";
import { triggerLabelWithAvailability } from "../thread/ModelPicker";

test("trigger label marks a model the provider no longer offers", () => {
  const a = { provider: "codex", model: "a", label: "Codex: Alpha", driver: "codex" };
  const b = { provider: "codex", model: "b", label: "Codex: Beta", driver: "codex" };
  expect(triggerLabelWithAvailability(a, [a, b]).endsWith("(Unavailable)")).toBe(false);
  expect(triggerLabelWithAvailability(a, [b]).endsWith(" (Unavailable)")).toBe(true);
});
