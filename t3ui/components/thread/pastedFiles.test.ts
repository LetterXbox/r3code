import { expect, test } from "nsh/test";
import { distinctPastedPaths } from "./pastedFiles";

test("pasting one native image represented twice stages it once", () => {
  expect(distinctPastedPaths(["hello world.png"], ["file:///tmp/hello%20world.png"])).toEqual([]);
  expect(distinctPastedPaths(["image.png"], ["file:///tmp/other.png"])).toEqual(["file:///tmp/other.png"]);
  expect(distinctPastedPaths(["a.png", "b.png"], ["file:///tmp/a.png"])).toEqual(["file:///tmp/a.png"]);
});
