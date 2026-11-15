import { expect, test } from "nsh/test";
import { flattenThoughtPreview } from "./workLog";

test("a reasoning preview flattens Markdown into label text", () => {
  expect(flattenThoughtPreview("## Plan\n\n- **Read** the `store.ts` file\n- see [docs](https://x.y)")).toBe("Plan Read the store.ts file see docs");
  expect(flattenThoughtPreview("> quoted _idea_ with $x^2$")).toBe("quoted idea with $x^2$");
  expect(flattenThoughtPreview("<b></b>")).toBe("");
});

test("a JavaScript REPL tool shows the code mark", async () => {
  const { workItemIconName } = await import("./workLog");
  expect(workItemIconName({ id: "a", type: "dynamic_tool", title: "js", detail: "", status: "completed", toolName: "node_repl.js" } as never)).toBe("code");
});
