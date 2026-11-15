import { expect, test } from "nsh/test";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT, foldSummaryOf, isSteerIntent, modelSwitchLabel, resolveUserMessageGrouping, resolveUserMessagePresentation } from "./userMessagePresentation";

const user = (over: Record<string, unknown> = {}) => ({ role: "user" as const, body: "hi", ...over });

test("a plain user message has no attribution; an agent's has; the server's is R3 Code", () => {
  expect(resolveUserMessagePresentation(user()).attribution).toBe(null);
  expect(resolveUserMessagePresentation(user({ createdBy: "agent", creationSource: "mcp" })).attribution).toBe("agent");
  expect(resolveUserMessagePresentation(user({ createdBy: "agent", creationSource: "server" })).attribution).toBe("t3code");
  expect(resolveUserMessagePresentation(user({ createdBy: "user", creationSource: "web" })).attribution).toBe(null);
});

test("a guest's message shows the guest's own words and name", () => {
  const result = resolveUserMessagePresentation(user({ body: "Guest Sam says: ship it", context: { version: 1, records: [], guest: { name: "Sam", text: "ship it" } } }));
  expect(result).toEqual({ text: "ship it", attribution: "guest", scheduledTaskId: undefined, guestName: "Sam" });
});

test("an automation message is recognised by its task id and by the legacy prefix", () => {
  expect(resolveUserMessagePresentation(user({ scheduledTaskId: "task-1" })).attribution).toBe("automation");
  const legacy = resolveUserMessagePresentation(user({ id: "scheduled-task-message:abc:1:scheduled", body: "[Triggered by schedule task: Nightly]\n\nRun the checks" }));
  expect(legacy).toEqual({ text: "Run the checks", attribution: "automation", scheduledTaskId: "abc" });
  expect(resolveUserMessagePresentation(user({ createdBy: "agent", body: "[Triggered by schedule task: Nightly]\n\nRun" })).attribution).toBe("automation");
});

test("the attachment-only bootstrap prompt shows as no text", () => {
  expect(resolveUserMessagePresentation(user({ body: ATTACHMENT_ONLY_BOOTSTRAP_PROMPT })).text).toBe("");
  expect(resolveUserMessagePresentation(user({ body: `Ultrathink:\n${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}` })).text).toBe("");
});

test("only the reader's own messages group, and a steer continues across a group", () => {
  const own = user({ inputIntent: "steer" });
  const other = user({ inputIntent: "steer", createdBy: "agent" });
  expect(resolveUserMessageGrouping(own, own, own)).toEqual({ groupedWithPrevious: true, groupedWithNext: true, continuesSteer: true });
  expect(resolveUserMessageGrouping(own, other, undefined)).toEqual({ groupedWithPrevious: false, groupedWithNext: false, continuesSteer: false });
  expect(resolveUserMessageGrouping({ role: "assistant", body: "x" }, own, own).groupedWithNext).toBe(false);
  expect(isSteerIntent("promoted_queued_to_steer")).toBe(true);
  expect(isSteerIntent("start_turn")).toBe(false);
});

test("a folded message summarises as its first non-blank line", () => {
  expect(foldSummaryOf("\n  \n  Check the build  \nthen deploy")).toBe("Check the build");
});

test("a model switch labels only what changed", () => {
  const name = (selection: { model: string }) => selection.model.toUpperCase();
  const sel = (model: string, effort?: string) => ({ instanceId: "codex", model, ...(effort ? { options: [{ id: "reasoningEffort", value: effort }] } : {}) });
  expect(modelSwitchLabel({ from: sel("a", "low"), to: sel("b", "low") }, name)).toBe("A → B");
  expect(modelSwitchLabel({ from: sel("a", "low"), to: sel("a", "high") }, name)).toBe("low → high");
  expect(modelSwitchLabel({ from: sel("a", "low"), to: sel("b", "high") }, name)).toBe("A low → B high");
  expect(modelSwitchLabel({ from: sel("a"), to: sel("a") }, name)).toBe(null);
});
