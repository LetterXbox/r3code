import { expect, test } from "nsh/test";
import { inlineText, tableToCsv, tableToMarkdown } from "./markdownTable";

const table = {
  align: ["left" as const, "right" as const],
  head: [{ content: [{ type: "text" as const, text: "Name" }] }, { content: [{ type: "text" as const, text: "Qty" }] }],
  rows: [
    [{ content: [{ type: "strong" as const, content: [{ type: "text" as const, text: "a|b" }] }] }, { content: [{ type: "code" as const, code: "1,5" }] }],
  ],
};

test("inlineText flattens formatting", () => {
  expect(inlineText([{ type: "text", text: "x " }, { type: "emphasis", content: [{ type: "text", text: "y" }] }])).toBe("x y");
});

test("table copies as markdown with alignment and escaped pipes", () => {
  expect(tableToMarkdown(table)).toBe("| Name | Qty |\n| :--- | ---: |\n| a\\|b | 1,5 |");
});

test("table copies as csv with quoting", () => {
  expect(tableToCsv(table)).toBe('Name,Qty\na|b,"1,5"');
});
