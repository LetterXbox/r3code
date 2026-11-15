import { expect, test } from "nsh/test";
import { docToPrompt, promptToDoc, type PromptTokenContext } from "./promptDocument";

const rich: PromptTokenContext = { richText: true, skills: new Map() };

// composer-rich-text-doc.ts: hard breaks and blank lines serialise back to the exact prompt text.
const cases = [
  "one\ntwo",
  "one\n\ntwo",
  "one\n\n\n\ntwo",
  "one\n",
  "one\n\n",
  "\none",
  "> quote\n\nprose after",
  "> quote\n> more\n\nprose",
  "- a\n- b\n\nafter",
  "```ts\nlet a = 1\n```\n\nafter",
  "**bold**\n\n*it*",
];
for (const text of cases) test(`round trips ${JSON.stringify(text)}`, () => { expect(docToPrompt(promptToDoc(text, rich))).toBe(text); });

test("prose straight after a quote keeps its separating blank line", () => {
  const doc = promptToDoc("> quote\n\nprose", rich);
  expect(docToPrompt(doc)).toBe("> quote\n\nprose");
  expect(doc.content!.length).toBeGreaterThan(1);
});

test("a bullet whose text becomes `[ ] ` turns into a task item by re-parsing the source", () => {
  const kinds = (text: string) => JSON.stringify(promptToDoc(text, rich));
  expect(kinds("- a")).toContain("listItem");
  expect(kinds("- [ ] a")).toContain("taskItem");
  expect(kinds("- [x] a")).toContain("taskItem");
  expect(docToPrompt(promptToDoc("- a\n- b", rich))).toBe("- a\n- b");
  expect(docToPrompt(promptToDoc("- ab", rich))).toBe("- ab");
});
