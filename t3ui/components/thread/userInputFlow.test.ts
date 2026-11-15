import { expect, test } from "nsh/test";
import { deriveProgress, isCompactPrimaryActions, optionForDigit, optionSelected, primaryLabel, resolveAnswer, toggleSelection, withCustomAnswer } from "./userInputFlow";
import type { UserInputQuestion } from "../../store";

const single: UserInputQuestion = { id: "a", header: "Mode", question: "Which?", options: [{ label: "One", description: "" }, { label: "Two", description: "", value: "two" }], multiSelect: false, allowCustomAnswer: true, required: true };
const multi: UserInputQuestion = { ...single, id: "b", header: "Extras", multiSelect: true };

test("digits 1 to 9 pick the matching option's value", () => {
  expect(optionForDigit(single, "1")).toBe("One");
  expect(optionForDigit(single, "2")).toBe("two");
  expect(optionForDigit(single, "3")).toBe(null);
  expect(optionForDigit(single, "0")).toBe(null);
  expect(optionForDigit(single, "x")).toBe(null);
  expect(optionForDigit(null, "1")).toBe(null);
});

test("progress tracks the active question, answered count and last question", () => {
  const first = deriveProgress([single, multi], {}, 0);
  expect(first.isLastQuestion).toBe(false);
  expect(first.canAdvance).toBe(false);
  const answered = deriveProgress([single, multi], { a: { selectedOptions: ["One"] } }, 0);
  expect(answered.canAdvance).toBe(true);
  expect(answered.isComplete).toBe(false);
  expect(deriveProgress([single, multi], { a: { selectedOptions: ["One"] }, b: { selectedOptions: ["two"] } }, 9).isComplete).toBe(true);
  expect(deriveProgress([single, multi], {}, 9).questionIndex).toBe(1);
  expect(deriveProgress([single, multi], {}, 9).isLastQuestion).toBe(true);
});

test("the primary action reads Next question, then Submit answer(s)", () => {
  expect(primaryLabel(deriveProgress([single, multi], {}, 0), false)).toBe("Next question");
  expect(primaryLabel(deriveProgress([single, multi], {}, 1), false)).toBe("Submit answers");
  expect(primaryLabel(deriveProgress([single], {}, 0), false)).toBe("Submit answer");
  expect(primaryLabel(deriveProgress([single], {}, 0), true)).toBe("Submitting...");
});

test("single select replaces, multi select toggles, and a typed answer displaces the option", () => {
  expect(toggleSelection(single, { selectedOptions: ["One"] }, "two").selectedOptions).toEqual(["two"]);
  expect(toggleSelection(multi, { selectedOptions: ["One"] }, "two").selectedOptions).toEqual(["One", "two"]);
  expect(toggleSelection(multi, { selectedOptions: ["One", "two"] }, "One").selectedOptions).toEqual(["two"]);
  const typed = withCustomAnswer(single, { selectedOptions: ["One"] }, "mine");
  expect(resolveAnswer(single, typed)).toBe("mine");
  const progress = deriveProgress([single], { a: typed }, 0);
  expect(optionSelected(progress, "One")).toBe(false);
  expect(optionSelected(deriveProgress([single], { a: { selectedOptions: ["One"] } }, 0), "One")).toBe(true);
  expect(withCustomAnswer(single, { selectedOptions: ["One"] }, "  ").selectedOptions).toEqual(["One"]);
});

test("the pending-answer actions go compact under 780 pt (composerFooterLayout.ts)", () => {
  expect(isCompactPrimaryActions(null)).toBe(false);
  expect(isCompactPrimaryActions(779)).toBe(true);
  expect(isCompactPrimaryActions(780)).toBe(false);
  expect(primaryLabel(deriveProgress([single, multi], {}, 0), false, true)).toBe("Next");
  expect(primaryLabel(deriveProgress([single, multi], {}, 1), false, true)).toBe("Submit");
  expect(primaryLabel(deriveProgress([single], {}, 0), true, true)).toBe("Submitting...");
});

test("a displaced custom answer joins the draft after a blank line", async () => {
  const { carryDisplacedCustomAnswerIntoPrompt } = await import("./userInputFlow");
  expect(carryDisplacedCustomAnswerIntoPrompt("", " typed ")).toBe("typed");
  expect(carryDisplacedCustomAnswerIntoPrompt("draft  ", "typed")).toBe("draft\n\ntyped");
  expect(carryDisplacedCustomAnswerIntoPrompt("draft", "  ")).toBe("draft");
});
