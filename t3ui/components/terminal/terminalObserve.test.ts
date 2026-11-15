import { expect, test } from "nsh/test";
import { terminalStreamMethod } from "./terminalObserve";

test("read without operate observes; operate (or an unanswered session) attaches", () => {
  expect(terminalStreamMethod("denied", "granted")).toBe("terminal.observe");
  expect(terminalStreamMethod("granted", "granted")).toBe("terminal.attach");
  expect(terminalStreamMethod("unknown", "granted")).toBe("terminal.attach");
  expect(terminalStreamMethod("denied", "denied")).toBe("terminal.attach");
});
