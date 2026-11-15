import { expect, test } from "nsh/test";
import { stackedPatch, type FilePatch } from "./stacked";

const file = (path: string) => ({ path, previousPath: null, additions: 1, deletions: 0 });
const ready = (patch: string, truncated = false): FilePatch => ({ state: "ready", patch, truncated, error: "" });

test("loaded files stack in the server's order; pending, failed, empty and cut ones are reported", () => {
  const result = stackedPatch([file("a"), file("b"), file("c"), file("d"), file("e")], {
    a: ready("diff a\n"),
    b: { state: "error", patch: "", truncated: false, error: "boom" },
    c: ready("", false),
    d: ready("diff d", true),
  });
  expect(result.text).toBe("diff a\ndiff d\n");
  expect(result.pending).toEqual(["e"]);
  expect(result.failed).toEqual([{ path: "b", key: "b", error: "boom" }]);
  expect(result.empty).toEqual(["c"]);
  expect(result.truncated).toEqual(["d"]);
});
