import { expect, test } from "nsh/test";
import { webLinkTarget } from "./ChatMarkdown";

test("Cmd/Ctrl-click and non-web links go to the system browser", () => {
  const none = { platform: false, control: false };
  expect(webLinkTarget("https://x.dev", none, true)).toBe("app");
  expect(webLinkTarget("https://x.dev", { platform: true, control: false }, true)).toBe("system");
  expect(webLinkTarget("https://x.dev", { platform: false, control: true }, true)).toBe("system");
  expect(webLinkTarget("mailto:a@b", none, true)).toBe("system");
  expect(webLinkTarget("https://x.dev", none, false)).toBe("system");
});
