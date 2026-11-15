import { expect, test } from "nsh/test";
import { promptLengthValidationMessage } from "./promptLength";

test("a prompt at the limit is valid; over it names the excess as the reference does", () => {
  expect(promptLengthValidationMessage("a".repeat(120_000))).toBe(null);
  expect(promptLengthValidationMessage(`  ${"a".repeat(120_000)}  `)).toBe(null);
  expect(promptLengthValidationMessage("a".repeat(120_001))).toBe("Prompt is 1 character over the 120,000-character limit. Shorten or split it before sending.");
  expect(promptLengthValidationMessage("a".repeat(121_500))).toBe("Prompt is 1,500 characters over the 120,000-character limit. Shorten or split it before sending.");
});
