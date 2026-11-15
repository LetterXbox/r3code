import { expect, test } from "nsh/test";
import { ADD_PROJECT_VALUE, headingFitsInline, pickerItems } from "./draftHeroLogic";

const projects = [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }];

test("the picker ends with Add project and searching filters by name without it", () => {
  expect(pickerItems(projects, "").map((item) => item.value)).toEqual(["a", "b", ADD_PROJECT_VALUE]);
  expect(pickerItems(projects, " BE ").map((item) => item.value)).toEqual(["b"]);
  expect(pickerItems(projects, "zzz")).toEqual([]);
});

test("the heading stays inline only when the container fits it", () => {
  expect(headingFitsInline(undefined, "Alpha")).toBe(false);
  expect(headingFitsInline(500, "Alpha")).toBe(false);
  expect(headingFitsInline(1024, "Alpha")).toBe(true);
  expect(headingFitsInline(700, "A very long project name that cannot fit")).toBe(false);
});
