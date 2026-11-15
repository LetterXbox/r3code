import { expect, test } from "nsh/test";
import { preservedOpenCodeOptions } from "./composerProviderState";

const saved = [{ id: "agent", value: "plan" }, { id: "variant", value: "high" }];

test("opencode: a model the catalog no longer lists keeps its saved options and drops the plan agent", () => {
  expect(preservedOpenCodeOptions({ driver: "opencode", model: "gone", catalog: [{ model: "here" }], options: saved })).toEqual({ applies: true, options: [{ id: "variant", value: "high" }] });
  expect(preservedOpenCodeOptions({ driver: "opencode", model: "gone", catalog: [], options: [{ id: "agent", value: "plan" }] })).toEqual({ applies: true, options: undefined });
  expect(preservedOpenCodeOptions({ driver: "opencode", model: "gone", catalog: [], options: saved, includePlanAgent: true })).toEqual({ applies: true, options: saved });
});

test("a listed model, or another driver, is left to the descriptors", () => {
  expect(preservedOpenCodeOptions({ driver: "opencode", model: "here", catalog: [{ model: "here" }], options: saved })).toEqual({ applies: false });
  expect(preservedOpenCodeOptions({ driver: "codex", model: "gone", catalog: [], options: saved })).toEqual({ applies: false });
});
