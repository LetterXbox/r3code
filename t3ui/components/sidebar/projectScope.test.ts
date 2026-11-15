import { expect, test } from "nsh/test";
import { expandProjectScope, inProjectScope, projectScopeIds, setProjectScope, toggleProjectScope, toggleProjectScopeMember } from "./projectScope";

test("a selected project includes checkouts added to its group later", () => {
  const groups = [{ members: [{ id: "a" }, { id: "new-checkout" }] }, { members: [{ id: "other" }] }];
  expect(expandProjectScope(["a"], groups)).toEqual(["a", "new-checkout"]);
  expect(expandProjectScope([], groups)).toEqual([]);
  expect(expandProjectScope(["other"], groups)).toEqual(["other"]);
});

test("no scope shows every project", () => {
  setProjectScope([]);
  expect(inProjectScope(projectScopeIds(), "a")).toBe(true);
});

test("a scope shows only its projects", () => {
  setProjectScope(["a"]);
  expect(inProjectScope(projectScopeIds(), "a")).toBe(true);
  expect(inProjectScope(projectScopeIds(), "b")).toBe(false);
  setProjectScope([]);
});

test("the menu item scopes to one project and a second use clears it", () => {
  setProjectScope([]);
  toggleProjectScope("a");
  expect(projectScopeIds()).toEqual(["a"]);
  toggleProjectScope("b");
  expect(projectScopeIds()).toEqual(["b"]);
  toggleProjectScope("b");
  expect(projectScopeIds()).toEqual([]);
});

test("shift-click adds and removes members of the scope", () => {
  setProjectScope(["a"]);
  toggleProjectScopeMember("b");
  expect(projectScopeIds()).toEqual(["a", "b"]);
  toggleProjectScopeMember("a");
  expect(projectScopeIds()).toEqual(["b"]);
  setProjectScope([]);
});

test("fm13: the project scope is saved on this device", async () => {
  const { Storage } = await import("nsh");
  const { setProjectScope } = await import("./projectScope");
  setProjectScope(["p1", "p2"]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(JSON.parse((await Storage.getItem("sidebarProjectScope:v1")) ?? "[]")).toEqual(["p1", "p2"]);
  setProjectScope([]);
});
