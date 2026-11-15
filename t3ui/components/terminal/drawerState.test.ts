import { expect, test } from "nsh/test";
import { drawerStateFor, updateDrawer } from "./drawerState";
import { newTerminal } from "./terminalLogic";

test("an unseen thread has no terminal until one is explicitly created", () => {
  const key = "drawer-state-empty-thread";
  expect(drawerStateFor(key).groups).toEqual([]);
  updateDrawer(key, (state) => newTerminal(state));
  expect(drawerStateFor(key).groups[0]?.terminalIds).toEqual(["term-1"]);
});
