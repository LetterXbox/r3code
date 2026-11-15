import { expect, test } from "nsh/test";
import { hasCommandHandler, registerCommandFallback, runCommand } from "./registry";
import { projectScriptIdFromCommand } from "./standardCommands";

test("script.<id>.run names a script id", () => {
  expect(projectScriptIdFromCommand("script.test-1.run")).toBe("test-1");
  expect(projectScriptIdFromCommand(" script.lint.run ")).toBe("lint");
  expect(projectScriptIdFromCommand("script..run")).toBe(null);
  expect(projectScriptIdFromCommand("script.Lint.run")).toBe(null);
  expect(projectScriptIdFromCommand("chat.new")).toBe(null);
});

test("a command fallback handles commands registered by no name", () => {
  const ran: string[] = [];
  const remove = registerCommandFallback((command) => (command === "script.build.run" ? () => { ran.push(command); } : undefined));
  expect(hasCommandHandler("script.build.run")).toBe(true);
  expect(hasCommandHandler("script.other.run")).toBe(false);
  expect(runCommand("script.build.run")).toBe(true);
  expect(ran).toEqual(["script.build.run"]);
  remove();
  expect(hasCommandHandler("script.build.run")).toBe(false);
});

test("with Mod+Enter sending, composer.sendAlternate on mod+enter resolves to mod+shift+enter", async () => {
  const { shortcutForContext } = await import("./registry");
  const rule = { command: "composer.sendAlternate", key: "mod+enter", when: "composerFocus && turnRunning" };
  expect(shortcutForContext(rule, true).key).toBe("mod+shift+enter");
  expect(shortcutForContext(rule, false).key).toBe("mod+enter");
  expect(shortcutForContext({ ...rule, key: "ctrl+enter" }, true).key).toBe("ctrl+enter");
});
