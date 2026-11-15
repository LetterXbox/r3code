import { expect, test } from "nsh/test";
import { buildPromptLink, formEncode, PROMPT_LINK_MAX_PROMPT_LENGTH } from "./promptLinks";

test("prompt links form-encode like URLSearchParams", () => {
  expect(formEncode("a b&c=d")).toBe("a+b%26c%3Dd");
  expect(formEncode("it's (x)!~*")).toBe("it%27s+%28x%29%21%7E*");
  expect(buildPromptLink("  fix the bug  ")).toBe("https://app.t3.codes/new?prompt=fix+the+bug");
});

test("an empty or oversized prompt has no link", () => {
  expect(buildPromptLink("   ")).toBeNull();
  expect(buildPromptLink("x".repeat(PROMPT_LINK_MAX_PROMPT_LENGTH + 1))).toBeNull();
  expect(buildPromptLink("x".repeat(PROMPT_LINK_MAX_PROMPT_LENGTH))).not.toBeNull();
});
