import { expect, test } from "nsh/test";
import { dismissSuggestion, offeredSuggestion, parsePromptSuggestion } from "./promptSuggestion";

test("a suggestion is offered for the latest completed run until Escape dismisses it", () => {
  const data = parsePromptSuggestion({ runId: "run-2", text: "Run the tests" });
  expect(offeredSuggestion({ environment: "e", data, latestRun: { id: "run-2", status: "completed" } })).toBe("Run the tests");
  expect(offeredSuggestion({ environment: "e", data, latestRun: { id: "run-2", status: "running" } })).toBe(null);
  expect(offeredSuggestion({ environment: "e", data, latestRun: { id: "run-3", status: "completed" } })).toBe(null);
  expect(parsePromptSuggestion(null)).toBe(null);
  dismissSuggestion("e", "run-2");
  expect(offeredSuggestion({ environment: "e", data, latestRun: { id: "run-2", status: "completed" } })).toBe(null);
  expect(offeredSuggestion({ environment: "other", data, latestRun: { id: "run-2", status: "completed" } })).toBe("Run the tests");
});
