import { expect, test } from "nsh/test";
import { createStableRows } from "./stableRows";

test("file rows survive equivalent refreshes but changed files and scopes do not reuse stale values", () => {
  type Row = { path: string; expanded: boolean; size: number; tokens: { text: string }[] };
  const stable = createStableRows<Row>((row) => row.path);
  const first = stable("project-a", [{ path: "src", expanded: true, size: 0, tokens: [] }, { path: "src/a.ts", expanded: false, size: 10, tokens: [{ text: "old" }] }]);
  const equivalent = stable("project-a", [{ path: "src", expanded: true, size: 0, tokens: [] }, { path: "src/a.ts", expanded: false, size: 10, tokens: [{ text: "old" }] }]);
  expect(equivalent === first).toBe(true);
  const changed = stable("project-a", [{ path: "src", expanded: true, size: 0, tokens: [] }, { path: "src/a.ts", expanded: false, size: 11, tokens: [{ text: "new" }] }]);
  expect(changed[0] === first[0]).toBe(true);
  expect(changed[1] === first[1]).toBe(false);
  expect(changed[1]?.tokens[0]?.text).toBe("new");
  const other = stable("project-b", [{ path: "src", expanded: true, size: 0, tokens: [] }]);
  expect(other[0] === changed[0]).toBe(false);
});

test("duplicate keys never reuse a different row", () => {
  const stable = createStableRows<{ id: string; text: string }>((row) => row.id);
  const first = stable("", [{ id: "a", text: "one" }, { id: "a", text: "two" }]);
  const next = stable("", [{ id: "a", text: "one" }, { id: "a", text: "two" }]);
  expect(next[0] === first[0]).toBe(false);
  expect(next[1] === first[1]).toBe(false);
  expect(next.map((row) => row.text)).toEqual(["one", "two"]);
});
