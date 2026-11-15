import { expect, test } from "nsh/test";
import { pullRequestFilterChoices } from "./pullRequestFilterChoices";

test("hosted authors remain visible after many loaded matches and duplicate names are folded", () => {
  const facets = Array.from({ length: 35 }, (_, index) => ({ name: `user${index}` }));
  const names = pullRequestFilterChoices(facets, ["USER0", "user-remote", "USER-REMOTE"], "user", "authors", []).map((item) => item.name);
  expect(names.length).toBe(30);
  expect(names[15]).toBe("user-remote");
  expect(names.filter((name) => name.toLowerCase() === "user-remote").length).toBe(1);
});

test("selected authors and labels remain available when the search does not match", () => {
  expect(pullRequestFilterChoices([{ name: "Alice" }], ["Bob"], "bob", "authors", ["alice"]).map((item) => item.name)).toEqual(["Alice", "Bob"]);
  expect(pullRequestFilterChoices([{ name: "Bug" }, { name: "Docs" }], [], "docs", "labels", ["bug"]).map((item) => item.name)).toEqual(["bug", "Docs"]);
});

test("label choices are not truncated at thirty", () => {
  const labels = Array.from({ length: 35 }, (_, index) => ({ name: `label${index}` }));
  expect(pullRequestFilterChoices(labels, [], "", "labels", []).length).toBe(35);
});
