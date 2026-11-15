import { expect, test } from "nsh/test";
import { isDefaultThreadDetailsVisibility, readThreadDetailsChoices, resolveThreadDetailsVisibility, setThreadDetailsItem, THREAD_DETAILS_ITEMS } from "./threadDetailsItems";

test("the defaults show everything but Usage limits and Context window", () => {
  const visibility = resolveThreadDetailsVisibility({});
  expect(THREAD_DETAILS_ITEMS.map((item) => item.label).slice(0, 3)).toEqual(["Environment and worktree", "Open in editor", "Project scripts"]);
  expect(visibility.scripts).toBe(true);
  expect(visibility.usage).toBe(false);
  expect(isDefaultThreadDetailsVisibility(visibility)).toBe(true);
});

test("only choices that differ from the default are stored", () => {
  let choices = setThreadDetailsItem({}, "scripts", false);
  expect(choices).toEqual({ scripts: false });
  expect(resolveThreadDetailsVisibility(choices).scripts).toBe(false);
  expect(isDefaultThreadDetailsVisibility(resolveThreadDetailsVisibility(choices))).toBe(false);
  choices = setThreadDetailsItem(choices, "scripts", true);
  expect(choices).toEqual({});
  expect(setThreadDetailsItem({}, "usage", true)).toEqual({ usage: true });
});

test("stored choices are read defensively", () => {
  expect(readThreadDetailsChoices({ scripts: false, usage: false, nope: true, branch: "x" })).toEqual({ scripts: false });
  expect(readThreadDetailsChoices(null)).toEqual({});
});
