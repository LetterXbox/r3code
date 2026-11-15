// The low-priority markdown and timeline items from coverage-audit/chat.md, as pure checks.
import { expect, test } from "nsh/test";
import { sourceControlHostIconName } from "./MarkdownChips";

test("a source-control host with a public domain shows its brand mark (MarkdownExternalLink sourceControlHostIcon)", () => {
  expect(sourceControlHostIconName("gitlab.com")).toBe("host-gitlab");
  expect(sourceControlHostIconName("www.bitbucket.org")).toBe("host-bitbucket");
  expect(sourceControlHostIconName("codeberg.org")).toBe("host-forgejo");
  expect(sourceControlHostIconName("example.com")).toBe(null);
});

test("a find match inside a closed details block opens it", async () => {
  const { detailsHoldsFindMatch } = await import("./ChatMarkdown");
  const children = [{ kind: "leaf", block: { type: "paragraph", content: [{ type: "text", text: "The hidden Needle sits here" }] }, flow: { mt: 0 } }];
  expect(detailsHoldsFindMatch(children, "needle")).toBe(true);
  expect(detailsHoldsFindMatch(children, "absent")).toBe(false);
  expect(detailsHoldsFindMatch(children, "  ")).toBe(false);
});

test("an automation's fold reads its scheduled task's title from the live tasks stream", async () => {
  const { scheduledTaskTitle, resetScheduledTaskTitlesForTests } = await import("../scheduledTaskTitle");
  resetScheduledTaskTitlesForTests();
  let push: ((value: unknown) => void) | null = null;
  const subscribe = (_method: string, _payload: unknown, receive: (value: unknown) => void) => { push = receive; return () => {}; };
  expect(scheduledTaskTitle("task-1", subscribe)).toBe(undefined);
  push!({ tasks: [{ id: "task-1", title: "Nightly triage", prompt: "p", enabled: true, schedule: { type: "interval", intervalMs: 3600000 }, projectId: "p", threadId: null, workspaceStrategy: { type: "root" }, modelSelection: { instanceId: "codex", model: "m" }, runtimeMode: "approval-required", interactionMode: "default", nextRunAt: null, lastRunStatus: "never", lastRunError: null }] });
  expect(scheduledTaskTitle("task-1", subscribe)).toBe("Nightly triage");
  expect(scheduledTaskTitle(undefined, subscribe)).toBe(undefined);
});
