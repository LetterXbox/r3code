import { expect, test } from "nsh/test";
import {
  deleteScript, nextProjectScriptId, primaryProjectScript, projectScriptMenuLabel, projectScriptTerminalInput, readProjectScripts, saveScript, scriptValidationError,
  EMPTY_PROJECT_SCRIPT_INPUT, buildProjectScript, commandForProjectScript, inputFromScript, releaseClaimedRoles, scriptFormRules, scriptPreviewToOpen,
} from "./projectScripts";

const scripts = readProjectScripts([
  { id: "setup", name: "Setup", command: "bun i", icon: "configure", runOnWorktreeCreate: true },
  { id: "test", name: "Test", command: "bun test", icon: "test", runOnWorktreeCreate: false },
  { id: "bad", name: "", command: "x" },
  "nope",
]);

test("malformed scripts are dropped and the primary one is the first ordinary script", () => {
  expect(scripts.map((script) => script.id)).toEqual(["setup", "test"]);
  expect(primaryProjectScript(scripts)?.id).toBe("test");
  expect(primaryProjectScript([scripts[0]!])?.id).toBe("setup");
  expect(primaryProjectScript([])).toBeNull();
  expect(projectScriptMenuLabel(scripts[0]!)).toBe("Setup (setup)");
  expect(projectScriptMenuLabel(scripts[1]!)).toBe("Test");
});

test("ids come from the name and stay unique", () => {
  expect(nextProjectScriptId("Run Tests!", [])).toBe("run-tests");
  expect(nextProjectScriptId("Test", ["test"])).toBe("test-2");
  expect(nextProjectScriptId("###", [])).toBe("script");
});

test("saving adds or replaces, deleting removes, and an empty form is refused", () => {
  const added = saveScript(scripts, null, { ...EMPTY_PROJECT_SCRIPT_INPUT, name: "Lint", command: " bun lint ", icon: "lint" });
  expect(added.at(-1)).toMatchObject({ id: "lint", name: "Lint", command: "bun lint", icon: "lint" });
  const edited = saveScript(added, "test", { ...EMPTY_PROJECT_SCRIPT_INPUT, name: "Tests", command: "bun test", icon: "test" });
  expect(edited.find((script) => script.id === "test")?.name).toBe("Tests");
  expect(deleteScript(edited, "lint").length).toBe(2);
  expect(scriptValidationError(EMPTY_PROJECT_SCRIPT_INPUT)).toBe("Name is required.");
  expect(scriptValidationError({ ...EMPTY_PROJECT_SCRIPT_INPUT, name: "a" })).toBe("Command is required.");
  expect(projectScriptTerminalInput("bun test")).toBe(" bun test\r");
});

test("the form's enabling rules and the saved record follow the web", () => {
  expect(scriptFormRules({ runOnWorktreeCreate: false, previewUrl: "" })).toEqual({ waitEnabled: false, autoOpenEnabled: false });
  expect(scriptFormRules({ runOnWorktreeCreate: true, previewUrl: " http://localhost:5173 " })).toEqual({ waitEnabled: true, autoOpenEnabled: true });
  const full = { ...EMPTY_PROJECT_SCRIPT_INPUT, name: " Dev ", command: " bun dev ", runOnWorktreeCreate: true, waitForSetup: true, runOnSettle: true, stopOnSettle: true, previewUrl: " http://localhost:5173 ", autoOpenPreview: true };
  expect(buildProjectScript("dev", full)).toEqual({
    id: "dev", name: "Dev", command: "bun dev", icon: "play", runOnWorktreeCreate: true, async: false, runOnSettle: true, stopOnSettle: true, previewUrl: "http://localhost:5173", autoOpenPreview: true,
  });
  // Waiting without the worktree run, and no preview URL, leave those fields out.
  expect(buildProjectScript("a", { ...EMPTY_PROJECT_SCRIPT_INPUT, name: "A", command: "x", waitForSetup: true, autoOpenPreview: true })).toEqual({ id: "a", name: "A", command: "x", icon: "play", runOnWorktreeCreate: false });
});

test("a saved script round-trips into the form and claims its roles from the others", () => {
  const saved = buildProjectScript("dev", { ...EMPTY_PROJECT_SCRIPT_INPUT, name: "Dev", command: "bun dev", runOnWorktreeCreate: true, waitForSetup: true, previewUrl: "http://x", autoOpenPreview: true });
  expect(inputFromScript(saved, "mod+k")).toMatchObject({ name: "Dev", runOnWorktreeCreate: true, waitForSetup: true, previewUrl: "http://x", autoOpenPreview: true, keybinding: "mod+k" });
  const other = { id: "setup", name: "Setup", command: "bun i", icon: "configure" as const, runOnWorktreeCreate: true, runOnSettle: true };
  expect(releaseClaimedRoles(other, { ...EMPTY_PROJECT_SCRIPT_INPUT, runOnWorktreeCreate: true })).toMatchObject({ runOnWorktreeCreate: false, runOnSettle: true });
  expect(saveScript([other], null, { ...EMPTY_PROJECT_SCRIPT_INPUT, name: "Dev", command: "x", runOnSettle: true })[0]).toMatchObject({ runOnWorktreeCreate: true, runOnSettle: false });
  expect(commandForProjectScript("run-tests")).toBe("script.run-tests.run");
  expect(commandForProjectScript("Bad Id")).toBeNull();
});

test("a run opens the preview only with auto-open on and a URL", () => {
  expect(scriptPreviewToOpen({ id: "a", name: "A", command: "x", icon: "play", runOnWorktreeCreate: false, previewUrl: "http://x", autoOpenPreview: true })).toBe("http://x");
  expect(scriptPreviewToOpen({ id: "a", name: "A", command: "x", icon: "play", runOnWorktreeCreate: false, previewUrl: "http://x", autoOpenPreview: false })).toBeNull();
  expect(scriptPreviewToOpen({ id: "a", name: "A", command: "x", icon: "play", runOnWorktreeCreate: false })).toBeNull();
});
