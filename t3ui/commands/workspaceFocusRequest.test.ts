import { expect, test } from "nsh/test";
import { createFocusTargets, currentWorkspaceFocusArea, registerFocusArea, requestWorkspaceFocus } from "./workspaceFocus";

test("requestWorkspaceFocus focuses a showing area and remembers it; a hidden or missing one is refused", () => {
  const log: string[] = [];
  let open = false;
  const release = registerFocusArea({ id: "details", focus: () => { log.push("details"); }, available: () => open });
  expect(requestWorkspaceFocus("details")).toBe(false);
  open = true;
  expect(requestWorkspaceFocus("details")).toBe(true);
  expect(currentWorkspaceFocusArea()).toBe("details");
  expect(requestWorkspaceFocus("nowhere")).toBe(false);
  expect(log).toEqual(["details"]);
  release();
});

test("a multi-control target focuses the first control still in the tree", async () => {
  const log: string[] = [];
  const targets = createFocusTargets();
  targets.track({ focus: () => log.push("gone"), measure: async () => null });
  targets.track({ focus: () => log.push("changes"), measure: async () => ({}) });
  expect(await targets.focusFirst()).toBe(true);
  expect(log).toEqual(["changes"]);
});
