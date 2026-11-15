import { expect, test } from "nsh/test";
import { buildPromptHistoryEntries, PLAN_IMPLEMENTATION_PROMPT_PREFIX } from "./promptHistory";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "../thread/timeline/userMessagePresentation";

test("plan implementation sends and the attachment-only bootstrap are not recalled", () => {
  const entries = buildPromptHistoryEntries([
    { id: "a", role: "user", body: "first" },
    { id: "b", role: "user", body: `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}# Plan` },
    { id: "c", role: "user", body: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT },
  ]);
  expect(entries).toEqual([{ id: "a", prompt: "first" }]);
});
