import { expect, test } from "nsh/test";
import type { ProjectScript } from "./projectScripts";
import { projectScriptsPatch, resolveProjectScripts } from "./scriptSettings";

const script = (id: string): ProjectScript => ({ id, name: id, command: id, icon: "play", runOnWorktreeCreate: false });
const project = { id: "p1", scripts: [script("own")] };

test("a project's override wins over the defaults and its own scripts", () => {
  const settings = { defaultProjectScripts: [script("default")], projectScriptOverrides: {}, projectSettingsOverrides: { p1: { defaultProjectScripts: [script("override")] } } };
  expect(resolveProjectScripts(settings, project).map((item) => item.id)).toEqual(["override"]);
  expect(resolveProjectScripts({ ...settings, projectSettingsOverrides: {} }, project).map((item) => item.id)).toEqual(["own"]);
  expect(resolveProjectScripts({ ...settings, projectSettingsOverrides: {} }, { id: "p1", scripts: [] }).map((item) => item.id)).toEqual(["default"]);
  expect(resolveProjectScripts({ ...settings, projectSettingsOverrides: {}, projectSettingsFolded: true }, project).map((item) => item.id)).toEqual(["default"]);
  expect(resolveProjectScripts(null, project).map((item) => item.id)).toEqual(["own"]);
});

test("saving writes the override beside the project's other overrides, and null clears only the scripts", () => {
  const settings = { projectSettingsOverrides: { p1: { defaultProjectScripts: [script("a")], other: 1 } } };
  expect(projectScriptsPatch(settings, "p1", [script("b")])).toEqual({ projectSettingsOverrides: { p1: { defaultProjectScripts: [script("b")], other: 1 } } });
  expect(projectScriptsPatch(settings, "p1", null)).toEqual({ projectSettingsOverrides: { p1: { other: 1 } } });
  expect(projectScriptsPatch({ projectSettingsOverrides: { p1: { defaultProjectScripts: [] } } }, "p1", null)).toEqual({ projectSettingsOverrides: { p1: null } });
});
