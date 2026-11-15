import { expect, test } from "nsh/test";
import { dedicatedSwitchValue, modelSelectionState } from "./ModelSelectionControl";

const codex = { instanceId: "codex", model: "gpt-5" };

test("a dedicated task follows the text generation model until it has its own", () => {
  const settings = { textGenerationModelSelection: codex, sourceControlWriterModelSelection: null };
  expect(modelSelectionState(settings, "sourceControlWriterModelSelection", true)).toEqual({ own: null, shown: codex });
  const own = { instanceId: "claude", model: "opus" };
  expect(modelSelectionState({ ...settings, sourceControlWriterModelSelection: own }, "sourceControlWriterModelSelection", true)).toEqual({ own, shown: own });
  expect(modelSelectionState(settings, "textGenerationModelSelection", false)).toEqual({ own: codex, shown: codex });
});

test("the dedicated switch clears the selection off and starts from the followed model on", () => {
  const models = [{ provider: "claude", model: "opus", label: "Claude: Opus", driver: "claude" }];
  expect(dedicatedSwitchValue(false, codex, models)).toBe(null);
  expect(dedicatedSwitchValue(true, codex, models)).toEqual(codex);
  expect(dedicatedSwitchValue(true, null, models)).toEqual({ instanceId: "claude", model: "opus" });
  expect(dedicatedSwitchValue(true, null, [])).toBe(null);
});
