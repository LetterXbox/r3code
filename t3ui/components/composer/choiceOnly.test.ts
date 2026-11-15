import { expect, test } from "nsh/test";
import { isChoiceOnlyPendingInput } from "./choiceOnly";

const question = (allowCustomAnswer: boolean) => ({ id: "q", header: "", question: "Pick", options: [{ label: "A", description: "" }], multiSelect: false, allowCustomAnswer, required: true });

test("a question without a custom answer makes the composer read Choose an option above", () => {
  expect(isChoiceOnlyPendingInput([])).toBe(false);
  expect(isChoiceOnlyPendingInput([{ id: "1", title: "", questions: [question(false)] }])).toBe(true);
  expect(isChoiceOnlyPendingInput([{ id: "1", title: "", questions: [question(false), question(true)] }])).toBe(false);
});
