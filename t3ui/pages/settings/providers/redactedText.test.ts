import { expect, test } from "nsh/test";
import { redactedPlaceholder } from "./RedactedText";

test("the placeholder is stable, keeps separators and hides every other character", () => {
  const value = "dev.name@example.com";
  const placeholder = redactedPlaceholder(value);
  expect(placeholder).toBe(redactedPlaceholder(value));
  expect(placeholder.length).toBe(value.length);
  for (let index = 0; index < value.length; index += 1) {
    if ("@._-".includes(value[index] as string)) expect(placeholder[index]).toBe(value[index]);
    else expect(placeholder[index]).not.toBe(value[index]);
  }
  expect(redactedPlaceholder("other@example.com")).not.toBe(redactedPlaceholder("dev@example.com"));
});
