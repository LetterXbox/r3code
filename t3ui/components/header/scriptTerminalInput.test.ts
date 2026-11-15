import { expect, test } from "nsh/test";
import { scriptTerminalInput } from "./projectScriptRun";

test("a chat code block keeps its command in shell history; a project script stays out of it", () => {
  expect(scriptTerminalInput("npm test", "preserve")).toBe("npm test\r");
  expect(scriptTerminalInput("npm test")).toBe(" npm test\r");
  expect(scriptTerminalInput("npm test", "suppress")).toBe(" npm test\r");
});
