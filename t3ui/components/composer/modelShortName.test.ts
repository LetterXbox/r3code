import { expect, test } from "nsh/test";
import { modelShortName } from "./modelShortName";

test("the trigger drops the native family prefix", () => {
  expect(modelShortName("Claude Haiku 5.5", "claudeAgent")).toBe("Haiku 5.5");
  expect(modelShortName("GPT-6 Astra", "codex")).toBe("6 Astra");
  expect(modelShortName("Sonnet 5", "claudeAgent")).toBe("Sonnet 5");
});
