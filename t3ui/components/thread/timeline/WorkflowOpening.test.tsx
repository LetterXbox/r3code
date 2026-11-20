import { expect, open, test } from "nsh/test";
import { isWorkflowScriptMessage, resolveWorkflowOpening, workflowOpeningHeadline } from "./WorkflowOpeningBlock";
import { readProjectedAgents } from "../../header/workflowModel";
import { parentProjection, script } from "./WorkflowOpeningFixture";

test("resolveWorkflowOpening: only a provider-native subagent thread whose first user message is the script", () => {
  expect(isWorkflowScriptMessage({ role: "user", text: "// plan\nexport const meta = {}" })).toBe(true);
  expect(isWorkflowScriptMessage({ role: "user", text: "// a\r// b\u2028/* c */\r\nexport const meta = {}" })).toBe(true);
  expect(isWorkflowScriptMessage({ role: "user", text: "// export const meta = {}" })).toBe(false);
  const dividers = `${"/".repeat(40)}\n`.repeat(40);
  expect(isWorkflowScriptMessage({ role: "user", text: `${dividers}const x = 1;` })).toBe(false);
  expect(isWorkflowScriptMessage({ role: "user", text: `${"/**/".repeat(200)}const x = 1;` })).toBe(false);
  expect(isWorkflowScriptMessage({ role: "user", text: "hello" })).toBe(false);
  expect(isWorkflowScriptMessage({ role: "user", text: "hello", workflowScript: true })).toBe(true);
  const messages = [{ id: "m1", role: "user", text: script }];
  expect(resolveWorkflowOpening({ threadId: "coordinator", providerNativeSubagent: false, messages, parentAgents: null })).toBe(null);
  const unloaded = resolveWorkflowOpening({ threadId: "coordinator", providerNativeSubagent: true, messages, parentAgents: null })!;
  expect(unloaded.group).toBe(null);
  expect(workflowOpeningHeadline(unloaded)).toEqual({ title: "Workflow", description: null, agents: null });
  const loaded = resolveWorkflowOpening({ threadId: "coordinator", providerNativeSubagent: true, messages, parentAgents: readProjectedAgents(parentProjection) })!;
  expect(workflowOpeningHeadline(loaded)).toEqual({ title: "Repo audit", description: "Audit the repo", agents: "2 agents · 1 working · 1 done" });
  expect(resolveWorkflowOpening({ threadId: "coordinator", providerNativeSubagent: true, messages: [{ id: "m1", role: "user", text: "plain" }], parentAgents: [] })).toBe(null);
});

test("the opening block shows the headline, phases with member rows, and folds the script", async () => {
  const app = await open("./WorkflowOpeningFixture.tsx", { width: 800, height: 900 });
  await expect(app.texts()).toContain("Workflow started");
  await expect(app.texts()).toContain("Repo audit");
  await expect(app.texts()).toContain("Audit the repo");
  await expect(app.texts()).toContain("2 agents · 1 working · 1 done");
  await expect(app.texts()).toContain("Scan");
  await expect(app.texts()).toContain("1/2");
  await expect(app.texts()).toContain("Found 3 issues");
  await app.press("label:Open Scan src");
  await app.waitFor("text:opened member-a");
  await expect(app.texts()).toContain("Show full script");
  await app.press("text:Show full script");
  await app.waitFor("text:Show less");
});
