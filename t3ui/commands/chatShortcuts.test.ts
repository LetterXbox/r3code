import { expect, test } from "nsh/test";
import { installStandardCommands } from "./standardCommands";
import { hasCommandHandler, runCommand } from "./registry";

test("thread.stop and the effort steps are registered, and stay unclaimed without a running thread or model", () => {
  installStandardCommands();
  for (const command of ["thread.stop", "composer.increaseEffort", "composer.decreaseEffort"]) {
    expect(hasCommandHandler(command)).toBe(true);
    // No open thread: the chord falls through to whatever else holds it.
    expect(runCommand(command)).toBe(false);
  }
});
