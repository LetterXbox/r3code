import { expect, test } from "nsh/test";
import { PreviewUrlNormalizationError, resolveAddressBarInput, resolveSearchUrlTemplate } from "./addressBar";

test("words search, hosts and addresses open, non-web schemes are refused", () => {
  expect(resolveAddressBarInput("how to center a div")).toBe("https://duckduckgo.com/?q=how%20to%20center%20a%20div");
  expect(resolveAddressBarInput("example.com")).toBe("https://example.com/");
  expect(resolveAddressBarInput("localhost:5173/app")).toBe("http://localhost:5173/app");
  expect(resolveAddressBarInput("react", resolveSearchUrlTemplate("google", ""))).toBe("https://www.google.com/search?q=react");
  expect(resolveSearchUrlTemplate("custom", "https://s.dev/?q=%s")).toBe("https://s.dev/?q=%s");
  expect(resolveSearchUrlTemplate("custom", "nope")).toBe("https://duckduckgo.com/?q=%s");
  let refused: unknown = null;
  try { resolveAddressBarInput("mailto:a@b.c"); } catch (cause) { refused = cause; }
  expect(refused instanceof PreviewUrlNormalizationError).toBe(true);
});
